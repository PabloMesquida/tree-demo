import * as THREE from 'three/webgpu'
import { createRandom } from '../utils/random.js'
import { ROLE_BRANCH, ROLE_STATIC, ROLE_TRUNK } from '../tree/TreeAsset.js'

/**
 * Procedural sway of the tree bones.
 *
 * Every animated bone is a damped angular spring around its rest pose. Its
 * state is a rotation vector expressed in world axes, so nothing here depends
 * on the bone's local axes or roll: any armature works as long as the bones
 * follow the trunk and branch naming rules.
 *
 *   - A push on a bone applies a torque to that bone and to its ancestors
 *     (longer lever arm, stiffer spring: the trunk leans a little).
 *   - Children are dragged by their parent's angular acceleration, which
 *     makes them lag behind and then overshoot.
 *   - Stiffness, damping and gain vary per bone, so branches do not move in
 *     unison.
 *
 * The integration runs at a fixed step, so the motion does not depend on the
 * frame rate.
 */

const STEP = 1 / 120
const MAX_STEPS = 10
const PUSH_GAIN = 110
const MAX_ACCELERATION = 400

const _q = new THREE.Quaternion()
const _restWorld = new THREE.Quaternion()
const _restWorldInverse = new THREE.Quaternion()
const _restLocal = new THREE.Quaternion()
const _axis = new THREE.Vector3()
const _head = new THREE.Vector3()
const _lever = new THREE.Vector3()
const _torque = new THREE.Vector3()

export class BranchRig
{
    constructor(asset, seed)
    {
        this.asset = asset
        this.enabled = true
        this.strength = 1

        const count = asset.bones.length
        this.count = count

        // Rest pose
        this.restLocal = new Float32Array(count * 4)
        this.restWorld = new Float32Array(count * 4)

        // Per bone tuning
        this.stiffness = new Float32Array(count)
        this.damping = new Float32Array(count)
        this.gain = new Float32Array(count)
        this.coupling = new Float32Array(count)
        this.maxAngle = new Float32Array(count)

        // State
        this.rotation = new Float32Array(count * 3)
        this.velocity = new Float32Array(count * 3)
        this.torque = new Float32Array(count * 3)
        this.drive = new Float32Array(count * 3) // angular acceleration passed down to children
        this.totalVelocity = new Float32Array(count * 3)
        this.shake = new Float32Array(count) // rad/s, own motion plus all the ancestors'
        this.maxShake = 0
        this.accumulator = 0

        const random = createRandom(seed * 104729 + 71)
        const branchDepth = new Uint8Array(count)
        const trunkDepth = new Uint8Array(count)

        asset.root.updateMatrixWorld(true)

        for(let i = 0; i < count; i++)
        {
            const bone = asset.bones[i]
            bone.quaternion.toArray(this.restLocal, i * 4)
            bone.getWorldQuaternion(_q).toArray(this.restWorld, i * 4)

            const parent = asset.parents[i]
            const role = asset.roles[i]
            branchDepth[i] = (parent === -1 ? 0 : branchDepth[parent]) + (role === ROLE_BRANCH ? 1 : 0)
            trunkDepth[i] = (parent === -1 ? 0 : trunkDepth[parent]) + (role === ROLE_TRUNK ? 1 : 0)

            let frequency = 0
            let dampingRatio = 0

            if(role === ROLE_TRUNK)
            {
                frequency = 1.1 + random.range(-0.1, 0.1)
                dampingRatio = 0.22
                this.gain[i] = 0.035 + 0.03 * trunkDepth[i]
                this.coupling[i] = 0.15
                this.maxAngle[i] = 0.07
            }
            else if(role === ROLE_BRANCH)
            {
                frequency = 1.5 + 0.28 * Math.min(branchDepth[i], 6) + random.range(-0.3, 0.3)
                dampingRatio = random.range(0.11, 0.2)
                this.gain[i] = random.range(0.7, 1.3)
                this.coupling[i] = random.range(0.45, 0.85)
                this.maxAngle[i] = 0.55
            }

            const omega = Math.PI * 2 * frequency
            this.stiffness[i] = omega * omega
            this.damping[i] = 2 * dampingRatio * omega
        }
    }

    /**
     * Forget the push of the previous frame. Called once per frame, before
     * the pointer applies the new one.
     */
    clearPush()
    {
        this.torque.fill(0)
    }

    /**
     * Push the tree at a world position. `force` is a world vector (the
     * pointer velocity in m/s).
     *
     * With `duration` = 0 it is a continuous push that lasts until the next
     * clearPush(). With a duration it is applied at once, as if it had been
     * held for that long: used for the kick when the pointer enters the tree.
     */
    applyPush(boneIndex, point, force, duration = 0)
    {
        if(!this.enabled) return

        const { asset, gain } = this
        const torque = duration > 0 ? this.velocity : this.torque
        const scale = PUSH_GAIN * this.strength / (asset.height * asset.height)

        // The hit bone and every ancestor up to the root
        for(let i = boneIndex; i !== -1; i = asset.parents[i])
        {
            if(asset.roles[i] === ROLE_STATIC) continue

            _head.setFromMatrixPosition(asset.bones[i].matrixWorld)
            _lever.subVectors(point, _head)
            _torque.crossVectors(_lever, force).multiplyScalar(scale * gain[i] * (duration > 0 ? duration : 1))

            torque[i * 3] += _torque.x
            torque[i * 3 + 1] += _torque.y
            torque[i * 3 + 2] += _torque.z
        }
    }

    /**
     * An instantaneous kick, used by the scripted determinism check.
     */
    applyImpulse(boneIndex, angularVelocity)
    {
        this.velocity[boneIndex * 3] += angularVelocity.x
        this.velocity[boneIndex * 3 + 1] += angularVelocity.y
        this.velocity[boneIndex * 3 + 2] += angularVelocity.z
    }

    /**
     * A push on every bone below the root, the same one every time: for
     * testing, and for the "sacudir todo" button.
     */
    shakeAll(strength = 2.2)
    {
        for(let i = 0; i < this.count; i++)
        {
            if(this.asset.parents[i] === -1) continue
            this.velocity[i * 3] += Math.sin(i * 12.9898) * strength * this.gain[i]
            this.velocity[i * 3 + 2] += Math.cos(i * 78.233) * strength * this.gain[i]
        }
    }

    update(deltaTime)
    {
        this.accumulator += deltaTime

        let steps = 0
        while(this.accumulator >= STEP && steps < MAX_STEPS)
        {
            this.step()
            this.accumulator -= STEP
            steps++
        }
        if(steps === MAX_STEPS) this.accumulator = 0

        if(steps > 0) this.applyToBones()
    }

    step()
    {
        const { asset, rotation, velocity, torque, drive, totalVelocity, shake } = this
        let maxShake = 0

        for(let i = 0; i < this.count; i++)
        {
            const parent = asset.parents[i]
            const i3 = i * 3
            const p3 = parent * 3

            if(asset.roles[i] === ROLE_STATIC)
            {
                // Static bones only relay what happens above them
                for(let a = 0; a < 3; a++)
                {
                    drive[i3 + a] = parent === -1 ? 0 : drive[p3 + a]
                    totalVelocity[i3 + a] = parent === -1 ? 0 : totalVelocity[p3 + a]
                }
                shake[i] = parent === -1 ? 0 : shake[parent]
                continue
            }

            const k = this.stiffness[i]
            const c = this.damping[i]
            const coupling = this.coupling[i]
            let lengthSq = 0

            for(let a = 0; a < 3; a++)
            {
                const inherited = parent === -1 ? 0 : drive[p3 + a]
                let acceleration = -k * rotation[i3 + a] - c * velocity[i3 + a] + torque[i3 + a] - coupling * inherited
                acceleration = Math.min(Math.max(acceleration, -MAX_ACCELERATION), MAX_ACCELERATION)

                velocity[i3 + a] += acceleration * STEP
                rotation[i3 + a] += velocity[i3 + a] * STEP
                lengthSq += rotation[i3 + a] * rotation[i3 + a]

                drive[i3 + a] = acceleration + inherited * 0.5
                totalVelocity[i3 + a] = velocity[i3 + a] + (parent === -1 ? 0 : totalVelocity[p3 + a])
            }

            // Hard limit, so no amount of pushing can fold a branch
            const limit = this.maxAngle[i]
            if(lengthSq > limit * limit)
            {
                const factor = limit / Math.sqrt(lengthSq)
                for(let a = 0; a < 3; a++)
                {
                    rotation[i3 + a] *= factor
                    velocity[i3 + a] *= 0.6
                }
            }

            shake[i] = Math.hypot(totalVelocity[i3], totalVelocity[i3 + 1], totalVelocity[i3 + 2])
            if(shake[i] > maxShake) maxShake = shake[i]
        }

        this.maxShake = maxShake
    }

    applyToBones()
    {
        const { asset, rotation } = this

        for(let i = 0; i < this.count; i++)
        {
            if(asset.roles[i] === ROLE_STATIC) continue

            const i3 = i * 3
            const angle = Math.hypot(rotation[i3], rotation[i3 + 1], rotation[i3 + 2])

            _restLocal.fromArray(this.restLocal, i * 4)

            if(angle < 1e-6)
            {
                asset.bones[i].quaternion.copy(_restLocal)
                continue
            }

            // World-axis rotation, brought into the bone's rest frame:
            // local = restLocal * restWorld^-1 * worldRotation * restWorld
            _axis.set(rotation[i3], rotation[i3 + 1], rotation[i3 + 2]).divideScalar(angle)
            _q.setFromAxisAngle(_axis, angle)
            _restWorld.fromArray(this.restWorld, i * 4)

            _restWorldInverse.copy(_restWorld).invert()

            asset.bones[i].quaternion
                .copy(_restLocal)
                .multiply(_q.premultiply(_restWorldInverse).multiply(_restWorld))
        }
    }

    reset()
    {
        this.rotation.fill(0)
        this.velocity.fill(0)
        this.torque.fill(0)
        this.drive.fill(0)
        this.totalVelocity.fill(0)
        this.shake.fill(0)
        this.maxShake = 0
        this.accumulator = 0

        for(let i = 0; i < this.count; i++)
            this.asset.bones[i].quaternion.fromArray(this.restLocal, i * 4)
    }
}
