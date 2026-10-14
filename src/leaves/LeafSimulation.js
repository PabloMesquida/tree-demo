import * as THREE from 'three/webgpu'
import { Fn, If, TWO_PI, float, hash, instanceIndex, instancedArray, int, max, min, mix, mx_noise_vec3, normalize, smoothstep, uint, uniform, vec3, vec4 } from 'three/tsl'
import { createBoneNodes, quatFromAxisAngle, quatMultiply, quatRotate } from '../utils/tsl.js'

/**
 * Leaf particles, simulated entirely on the GPU.
 *
 * One particle per anchor, for the whole life of the page: particles are
 * never created or destroyed, they cycle through three states.
 *
 *   ATTACHED  glued to its anchor (bone matrix * anchor), full size.
 *             Leaves it when its branch shakes harder than the leaf's grip.
 *   FALLING   free body in world space: gravity, drag towards the wind,
 *             tumbling. Lands, rests, shrinks away.
 *   GROWING   back on its anchor, scaling up from zero, then ATTACHED again.
 *
 * Only the first `count` particles are simulated and drawn; the buffers are
 * sized for `capacity`, so the number of leaves can change at run time
 * without reallocating anything.
 *
 * Storage buffers (fixed size = capacity):
 *
 *   anchorData        vec4  xyz anchor position in bone space, w bone index   (static)
 *   anchorQuaternion  vec4  leaf frame in bone space                          (static)
 *   position          vec4  xyz world position, w scale 0..1
 *   velocity          vec4  xyz world velocity, w time spent in the current phase
 *   orientation       vec4  world quaternion
 *   state             vec4  x state, y regrowth cycle, z landed flag
 */

export const STATE_ATTACHED = 0
export const STATE_FALLING = 1
export const STATE_GROWING = 2

// Detach decisions are taken on a fixed clock, not per frame, so the chance
// of losing a leaf does not depend on the frame rate.
const DECISION_RATE = 20

const GRIP_SPREAD = 4 // a leaf lets go between 1x and (1 + spread)x the threshold
const MIN_ATTACHED_TIME = 1 // seconds a regrown leaf is safe
const MAX_INHERITED_SPEED = 5
const MAX_FALL_TIME = 12
const REST_TIME = 2.5 // seconds on the ground before disappearing
const FADE_TIME = 0.5
const REGROW_DELAY = 1.5

export class LeafSimulation
{
    constructor(renderer, anchors, boneState, seed)
    {
        this.renderer = renderer
        this.boneState = boneState
        this.capacity = anchors.count
        this.count = anchors.count // active leaves, see setActiveCount()
        this.time = 0
        this.lastTick = -1

        const count = this.capacity

        // Static buffers, filled once from the anchor set
        const anchorData = new Float32Array(count * 4)
        for(let i = 0; i < count; i++)
        {
            anchorData[i * 4] = anchors.position[i * 3]
            anchorData[i * 4 + 1] = anchors.position[i * 3 + 1]
            anchorData[i * 4 + 2] = anchors.position[i * 3 + 2]
            anchorData[i * 4 + 3] = anchors.bone[i]
        }
        this.anchorData = instancedArray(anchorData, 'vec4')
        this.anchorQuaternion = instancedArray(new Float32Array(anchors.quaternion), 'vec4')

        // Dynamic buffers, only ever written by the compute shader
        this.position = instancedArray(count, 'vec4')
        this.velocity = instancedArray(count, 'vec4')
        this.orientation = instancedArray(count, 'vec4')
        this.state = instancedArray(count, 'vec4')

        this.uniforms = {
            deltaTime: uniform(0),
            time: uniform(0),
            seed: uniform(seed, 'uint'),
            tick: uniform(0, 'uint'),
            tickFired: uniform(0),
            reset: uniform(1),
            fallEnabled: uniform(1),
            regenEnabled: uniform(1),
            detachProbability: uniform(0.25),
            detachThreshold: uniform(1.2),
            gravity: uniform(4),
            wind: uniform(new THREE.Vector3()),
            growDuration: uniform(1.5),
            groundY: uniform(0)
        }

        this.updateCompute = this.createUpdateCompute()

        // Reusable handle for reading the state buffer back (debug counters)
        this.readback = new THREE.ReadbackBuffer(count * 16)
        this.readback.name = 'leafState'
        this.pendingRead = Promise.resolve()
        this.counts = { attached: count, falling: 0, growing: 0, total: count }

        // First run: reset = 1 puts every leaf on its anchor
        this.step(0)
    }

    createUpdateCompute()
    {
        const u = this.uniforms
        const bones = createBoneNodes(this.boneState)

        // Random numbers: three's hash() is a PCG hash, uint -> [0, 1)
        const leafKey = instanceIndex.mul(uint(7477)).add(u.seed.mul(uint(2654435761)))
        const random = (salt) => hash(leafKey.add(uint(salt * 7919)))

        return Fn(() =>
        {
            const positionBuffer = this.position.element(instanceIndex)
            const velocityBuffer = this.velocity.element(instanceIndex)
            const orientationBuffer = this.orientation.element(instanceIndex)
            const stateBuffer = this.state.element(instanceIndex)
            const anchor = this.anchorData.element(instanceIndex)

            // Where the anchor is right now
            const boneIndex = int(anchor.w)
            const anchorPosition = bones.matrices.element(boneIndex).mul(vec4(anchor.xyz, 1)).xyz.toVar()
            const anchorOrientation = quatMultiply(
                bones.quaternions.element(boneIndex),
                this.anchorQuaternion.element(instanceIndex)
            ).toVar()

            // Working copies, written back at the end
            const position = positionBuffer.xyz.toVar()
            const scale = positionBuffer.w.toVar()
            const velocity = velocityBuffer.xyz.toVar()
            const timer = velocityBuffer.w.toVar()
            const orientation = orientationBuffer.toVar()
            const state = stateBuffer.x.toVar()
            const cycle = stateBuffer.y.toVar()
            const landed = stateBuffer.z.toVar()

            // Random numbers that change every time the leaf regrows
            const cycleKey = leafKey.add(uint(cycle).mul(uint(15485863)))
            const randomCycle = (salt) => hash(cycleKey.add(uint(salt * 7919)))

            If(u.reset.greaterThan(0.5), () =>
            {
                state.assign(STATE_ATTACHED)
                cycle.assign(0)
                landed.assign(0)
                timer.assign(1000)
                position.assign(anchorPosition)
                scale.assign(1)
                velocity.assign(vec3(0))
                orientation.assign(anchorOrientation)
            })
            .ElseIf(state.lessThan(0.5), () =>
            {
                /**
                 * ATTACHED
                 */
                // Keep the branch velocity: it is what the leaf leaves with
                velocity.assign(anchorPosition.sub(position).div(u.deltaTime.max(0.0001)))
                position.assign(anchorPosition)
                orientation.assign(anchorOrientation)
                scale.assign(1)
                timer.addAssign(u.deltaTime)

                const shake = bones.shakes.element(boneIndex)
                const grip = u.detachThreshold.mul(randomCycle(1).mul(GRIP_SPREAD).add(1))
                const roll = hash(leafKey.add(u.tick.mul(uint(32452843))).add(uint(999331)))

                const letGo = u.fallEnabled.greaterThan(0.5)
                    .and(u.tickFired.greaterThan(0.5))
                    .and(timer.greaterThan(MIN_ATTACHED_TIME))
                    .and(shake.greaterThan(grip))
                    .and(roll.lessThan(u.detachProbability))

                If(letGo, () =>
                {
                    state.assign(STATE_FALLING)
                    landed.assign(0)
                    timer.assign(0)

                    const speed = velocity.length()
                    const kick = vec3(randomCycle(2).sub(0.5), randomCycle(3).mul(0.5), randomCycle(4).sub(0.5))

                    velocity.mulAssign(min(speed, MAX_INHERITED_SPEED).div(max(speed, 0.0001)).mul(0.7))
                    velocity.addAssign(kick.mul(0.9))
                    velocity.addAssign(quatRotate(orientation, vec3(0, 1, 0)).mul(0.4))
                })
            })
            .ElseIf(state.lessThan(1.5), () =>
            {
                /**
                 * FALLING
                 */
                timer.addAssign(u.deltaTime)

                If(landed.lessThan(0.5), () =>
                {
                    // Air: steady wind, large gusts, small per-leaf flutter
                    const gust = mx_noise_vec3(position.mul(0.55).add(vec3(u.time.mul(0.35), 0, u.time.mul(0.2))))
                    const flutter = mx_noise_vec3(position.mul(1.9).add(random(6).mul(40)).add(u.time.mul(0.9)))
                    const air = u.wind.mul(gust.x.mul(0.6).add(1))
                        .add(gust.mul(u.wind.length()).mul(0.5))
                        .add(flutter.mul(0.55))

                    // Drag pulls the leaf towards the air velocity; each leaf has its own
                    const drag = mix(1.4, 2.6, random(5))
                    const acceleration = vec3(0, u.gravity.negate(), 0).add(air.sub(velocity).mul(drag))

                    velocity.addAssign(acceleration.mul(u.deltaTime))
                    position.addAssign(velocity.mul(u.deltaTime))

                    // Tumble
                    const axis = normalize(vec3(randomCycle(7), randomCycle(8), randomCycle(9)).sub(0.5).add(0.001))
                    const spin = mix(2, 7, randomCycle(10))
                    orientation.assign(normalize(quatMultiply(quatFromAxisAngle(axis, spin.mul(u.deltaTime)), orientation)))

                    const ground = u.groundY.add(random(13).mul(0.02)).add(0.01)

                    If(position.y.lessThan(ground), () =>
                    {
                        // Landed: lie flat, facing a random direction
                        position.y.assign(ground)
                        velocity.assign(vec3(0))
                        orientation.assign(quatMultiply(
                            quatFromAxisAngle(vec3(0, 1, 0), randomCycle(14).mul(TWO_PI)),
                            vec4(-0.70710678, 0, 0, 0.70710678)
                        ))
                        landed.assign(1)
                        timer.assign(0)
                    })
                    .ElseIf(timer.greaterThan(MAX_FALL_TIME), () =>
                    {
                        // Never reached the ground (blown away): recycle it anyway
                        velocity.assign(vec3(0))
                        landed.assign(1)
                        timer.assign(0)
                    })
                })
                .Else(() =>
                {
                    // On the ground: rest, shrink away, then go back to the anchor
                    const rest = mix(0.6, 1.4, random(12)).mul(REST_TIME)

                    If(u.regenEnabled.lessThan(0.5), () =>
                    {
                        timer.assign(min(timer, rest.sub(FADE_TIME)))
                    })

                    scale.assign(smoothstep(rest.sub(FADE_TIME), rest, timer).oneMinus())

                    If(timer.greaterThanEqual(rest), () =>
                    {
                        state.assign(STATE_GROWING)
                        landed.assign(0)
                        cycle.addAssign(1)
                        timer.assign(random(11).mul(REGROW_DELAY).negate())
                        scale.assign(0)
                        velocity.assign(vec3(0))
                        position.assign(anchorPosition)
                        orientation.assign(anchorOrientation)
                    })
                })
            })
            .Else(() =>
            {
                /**
                 * GROWING
                 */
                // The timer starts negative: that is the delay before the bud appears
                timer.addAssign(u.deltaTime)
                position.assign(anchorPosition)
                orientation.assign(anchorOrientation)
                velocity.assign(vec3(0))
                scale.assign(smoothstep(0, 1, timer.div(u.growDuration.max(0.01))))

                If(timer.greaterThanEqual(u.growDuration), () =>
                {
                    state.assign(STATE_ATTACHED)
                    timer.assign(0)
                    scale.assign(1)
                })
            })

            positionBuffer.assign(vec4(position, scale))
            velocityBuffer.assign(vec4(velocity, timer))
            orientationBuffer.assign(orientation)
            stateBuffer.assign(vec4(state, cycle, landed, float(0)))
        })().compute(this.capacity)
    }

    /**
     * Advance the simulation. Must run after the rig has posed the bones.
     */
    step(deltaTime)
    {
        const u = this.uniforms

        this.time += deltaTime
        const tick = Math.floor(this.time * DECISION_RATE)

        u.deltaTime.value = deltaTime
        u.time.value = this.time
        u.tick.value = tick
        u.tickFired.value = tick !== this.lastTick ? 1 : 0
        this.lastTick = tick

        this.boneState.update()

        // A reset reaches every leaf, active or not, so a leaf switched on later starts clean
        const dispatch = u.reset.value > 0.5 ? this.capacity : this.count
        if(dispatch > 0) this.renderer.compute(this.updateCompute, dispatch)

        u.reset.value = 0
    }

    /**
     * New anchor orientations (bone space), e.g. after orientAnchors(). Leaves
     * on the tree turn at once; falling leaves keep their own orientation.
     */
    setAnchorQuaternions(quaternions)
    {
        const attribute = this.anchorQuaternion.value
        attribute.array.set(quaternions)
        attribute.needsUpdate = true
    }

    /**
     * How many leaves are simulated and drawn, from 0 to capacity. Leaves
     * switched off keep their state; switched on again, they carry on from it.
     */
    setActiveCount(count)
    {
        this.count = Math.max(0, Math.min(Math.round(count), this.capacity))
    }

    /**
     * Put every leaf back on its anchor on the next step.
     */
    reset()
    {
        this.time = 0
        this.lastTick = -1
        this.uniforms.reset.value = 1
    }

    /**
     * Read the state buffer back from the GPU and count the leaves per state.
     * Debug only: it is asynchronous and lags a frame or two behind.
     */
    readCounts()
    {
        // The readback handle can only be mapped once at a time, so reads are
        // queued: every caller gets counts taken after its own call.
        this.pendingRead = this.pendingRead.catch(() => {}).then(() => this.readCountsNow())
        return this.pendingRead
    }

    async readCountsNow()
    {
        if(this.count === 0)
        {
            Object.assign(this.counts, { attached: 0, falling: 0, growing: 0, total: 0 })
            return this.counts
        }

        try
        {
            // Only the active part of the buffer
            await this.renderer.getArrayBufferAsync(this.state.value, this.readback, 0, this.count * 16)

            const data = new Float32Array(this.readback.buffer)
            let attached = 0
            let falling = 0
            let growing = 0

            for(let i = 0; i < this.count; i++)
            {
                const state = data[i * 4]
                if(state < 0.5) attached++
                else if(state < 1.5) falling++
                else growing++
            }

            this.counts.attached = attached
            this.counts.falling = falling
            this.counts.growing = growing
            this.counts.total = attached + falling + growing
        }
        finally
        {
            this.readback.release()
        }

        return this.counts
    }

    /**
     * Full copy of a storage buffer, for the scripted checks.
     */
    async readBuffer(buffer)
    {
        return new Float32Array(await this.renderer.getArrayBufferAsync(buffer.value))
    }
}
