import * as THREE from 'three/webgpu'
import { options } from '../config.js'
import { ROLE_BRANCH } from '../tree/TreeAsset.js'

/**
 * Scripted checks, run from the browser console:
 *
 *     await demo.checks.anchors()       attached leaves sit exactly on bone * anchor
 *     await demo.checks.lifecycle()     shake -> fall -> regrow, totals always coherent
 *     await demo.checks.determinism()   same seed + same inputs = same buffers
 *     await demo.checks.memory()        many cycles, no growth in GPU resources
 *
 * They pause the live loop and drive the rig and the simulation directly with
 * a fixed 1/60 s step and no pointer input, so the result does not depend on
 * the machine's frame rate.
 */

const STEP = 1 / 60

export function createChecks(demo)
{
    const { asset, anchors, rig, simulation, params, applyParams } = demo

    // The same push on every branch bone, always identical
    const shake = (strength = 2.6) =>
    {
        for(let i = 0; i < rig.count; i++)
        {
            if(asset.roles[i] !== ROLE_BRANCH) continue
            rig.velocity[i * 3] += Math.sin(i * 12.9898) * strength * rig.gain[i]
            rig.velocity[i * 3 + 2] += Math.cos(i * 78.233) * strength * rig.gain[i]
        }
    }

    const advance = (frames) =>
    {
        for(let i = 0; i < frames; i++)
        {
            rig.clearPush()
            rig.update(STEP)
            simulation.step(STEP)
        }
    }

    const restart = () =>
    {
        rig.reset()
        simulation.reset()
        advance(1)
    }

    // Run a check with the live loop paused and the parameters restored after
    const isolated = async (overrides, run) =>
    {
        const saved = { ...params }
        demo.state.paused = true
        Object.assign(params, overrides)
        applyParams()

        try
        {
            return await run()
        }
        finally
        {
            Object.assign(params, saved)
            applyParams()
            restart()
            demo.state.paused = false
        }
    }

    const hashBuffer = (data) =>
    {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        let hash = 0x811c9dc5
        for(let i = 0; i < bytes.length; i++)
        {
            hash ^= bytes[i]
            hash = Math.imul(hash, 0x01000193)
        }
        return (hash >>> 0).toString(16).padStart(8, '0')
    }

    return {
        /**
         * With the tree bent and falling disabled, every leaf must be exactly
         * where the CPU says its anchor is: bone.matrixWorld * anchor.
         */
        anchors: () => isolated({ leafFall: false }, async () =>
        {
            restart()
            shake(3)
            advance(20)

            const positions = await simulation.readBuffer(simulation.position)
            const expected = new THREE.Vector3()
            const rest = new THREE.Vector3()
            let maxError = 0
            let maxDisplacement = 0

            for(let i = 0; i < simulation.count; i++)
            {
                const bone = asset.bones[anchors.bone[i]]
                expected.fromArray(anchors.position, i * 3).applyMatrix4(bone.matrixWorld)
                maxError = Math.max(maxError, expected.distanceTo(rest.fromArray(positions, i * 4)))
            }

            // How far the pose is from rest, to prove the test is not trivial
            const posed = asset.bones.map((bone) => bone.matrixWorld.clone())
            rig.reset()
            asset.root.updateMatrixWorld(true)
            for(let i = 0; i < simulation.count; i++)
            {
                const b = anchors.bone[i]
                expected.fromArray(anchors.position, i * 3).applyMatrix4(posed[b])
                rest.fromArray(anchors.position, i * 3).applyMatrix4(asset.bones[b].matrixWorld)
                maxDisplacement = Math.max(maxDisplacement, expected.distanceTo(rest))
            }

            return {
                pass: maxError < 1e-3 && maxDisplacement > 0.01,
                maxErrorMeters: maxError,
                maxAnchorDisplacementMeters: maxDisplacement,
                leaves: simulation.count
            }
        }),

        /**
         * Leaf orientation, read back from the GPU: with no scatter and no
         * upward bend, every attached leaf must leave its branch at exactly
         * the requested angle, towards the outside.
         */
        orientation: (angle = 30) => isolated({ leafFall: false, leafAngle: angle, leafAngleVariation: 0, leafRollVariation: 0, leafUpward: 0 }, async () =>
        {
            if(anchors.frame === null) return { pass: false, reason: 'Anclajes explícitos: su orientación viene de Blender.' }

            restart()
            advance(2)

            const orientations = await simulation.readBuffer(simulation.orientation)
            const boneRotation = new THREE.Quaternion()
            const leaf = new THREE.Quaternion()
            const grow = new THREE.Vector3()
            const branch = new THREE.Vector3()
            const outward = new THREE.Vector3()
            let minAngle = 180
            let maxAngle = 0
            let inward = 0

            for(let i = 0; i < simulation.count; i++)
            {
                asset.bones[anchors.bone[i]].getWorldQuaternion(boneRotation)
                leaf.fromArray(orientations, i * 4)
                grow.set(0, 1, 0).applyQuaternion(leaf)
                branch.fromArray(anchors.frame.direction, i * 3).applyQuaternion(boneRotation)
                outward.fromArray(anchors.frame.radial, i * 3).applyQuaternion(boneRotation)

                const measured = THREE.MathUtils.radToDeg(grow.angleTo(branch))
                minAngle = Math.min(minAngle, measured)
                maxAngle = Math.max(maxAngle, measured)
                if(angle > 0 && grow.dot(outward) <= 0) inward++
            }

            return {
                pass: Math.abs(minAngle - angle) < 0.05 && Math.abs(maxAngle - angle) < 0.05 && inward === 0,
                requestedDegrees: angle,
                measuredDegrees: [+minAngle.toFixed(3), +maxAngle.toFixed(3)],
                pointingInwards: inward,
                leaves: simulation.count
            }
        }),

        /**
         * One shake, then follow the counters until every leaf is attached again.
         */
        lifecycle: () => isolated({ leafFall: true, regeneration: true }, async () =>
        {
            restart()
            shake()

            const timeline = []
            let coherent = true
            let peakFalling = 0
            let peakGrowing = 0
            let frames = 0
            let counts

            do
            {
                advance(30)
                frames += 30
                counts = { ...await simulation.readCounts() }
                coherent = coherent && counts.total === simulation.count
                peakFalling = Math.max(peakFalling, counts.falling)
                peakGrowing = Math.max(peakGrowing, counts.growing)
                timeline.push(`${(frames * STEP).toFixed(1)}s  ${counts.attached}/${counts.falling}/${counts.growing}`)
            }
            while(counts.attached < simulation.count && frames < 60 * 60)

            return {
                pass: coherent && peakFalling > 0 && peakGrowing > 0 && counts.attached === simulation.count,
                coherentTotals: coherent,
                peakFalling,
                peakGrowing,
                detachedFraction: peakFalling / simulation.count,
                secondsToRecover: frames * STEP,
                timeline
            }
        }),

        /**
         * The same scripted run twice: the GPU buffers must match bit for bit.
         */
        determinism: () => isolated({ leafFall: true, regeneration: true }, async () =>
        {
            const run = async () =>
            {
                restart()
                shake()
                advance(150)
                shake(2)
                advance(270)

                const state = await simulation.readBuffer(simulation.state)
                const position = await simulation.readBuffer(simulation.position)
                const counts = { ...await simulation.readCounts() }

                return { hash: `${hashBuffer(state)}-${hashBuffer(position)}`, counts }
            }

            const first = await run()
            const second = await run()

            return {
                pass: first.hash === second.hash && first.counts.falling + first.counts.growing > 0,
                first,
                second
            }
        }),

        /**
         * GLB only: compare the loaded rest pose with the positions written by
         * tools/blender/make_test_tree.py next to the file (*.expected.json).
         * Proves that bones and explicit anchors survive the Blender export
         * with the axes this demo assumes.
         */
        glb: () => isolated({}, async () =>
        {
            if(options.tree !== 'glb') return { pass: false, reason: 'Carga un GLB primero (?tree=glb).' }

            const response = await fetch(options.glb.replace(/\.glb$/i, '.expected.json'))
            if(!response.ok) return { pass: false, reason: 'No hay archivo .expected.json junto al GLB.' }
            const expected = await response.json()

            rig.reset()
            asset.root.updateMatrixWorld(true)

            const position = new THREE.Vector3()
            const target = new THREE.Vector3()
            const grow = new THREE.Vector3()
            const quaternion = new THREE.Quaternion()
            const missing = []
            let maxBoneError = 0
            let maxAnchorError = 0
            let minGrowAlignment = 1
            let wrongBone = 0

            for(const bone of expected.bones)
            {
                const index = asset.bones.findIndex((candidate) => candidate.name === bone.name)
                if(index === -1) { missing.push(bone.name); continue }

                position.setFromMatrixPosition(asset.bones[index].matrixWorld)
                maxBoneError = Math.max(maxBoneError, position.distanceTo(target.fromArray(bone.head)))

                const parent = asset.parents[index] === -1 ? null : asset.bones[asset.parents[index]].name
                if(parent !== bone.parent) missing.push(`${bone.name}: padre ${parent}, esperado ${bone.parent}`)
            }

            for(const anchor of expected.anchors)
            {
                const index = anchors.names === null ? -1 : anchors.names.indexOf(anchor.name)
                if(index === -1) { missing.push(anchor.name); continue }

                const bone = asset.bones[anchors.bone[index]]
                if(bone.name !== anchor.bone) wrongBone++

                position.fromArray(anchors.position, index * 3).applyMatrix4(bone.matrixWorld)
                maxAnchorError = Math.max(maxAnchorError, position.distanceTo(target.fromArray(anchor.position)))

                // The leaf grows along the anchor's local +Y
                bone.getWorldQuaternion(quaternion).multiply(new THREE.Quaternion().fromArray(anchors.quaternion, index * 4))
                grow.set(0, 1, 0).applyQuaternion(quaternion)
                minGrowAlignment = Math.min(minGrowAlignment, grow.dot(target.fromArray(anchor.grow)))
            }

            return {
                pass: missing.length === 0 && wrongBone === 0 && maxBoneError < 1e-4 && maxAnchorError < 1e-4 && minGrowAlignment > 0.999,
                bones: expected.bones.length,
                anchors: expected.anchors.length,
                maxBoneErrorMeters: maxBoneError,
                maxAnchorErrorMeters: maxAnchorError,
                minGrowAlignment,
                wrongBone,
                missing
            }
        }),

        /**
         * Many shake/fall/regrow cycles. Buffers are fixed size and nothing is
         * created per cycle, so the renderer's resource counters must not move.
         */
        memory: (cycles = 20) => isolated({ leafFall: true, regeneration: true, growDuration: 0.3 }, async () =>
        {
            const snapshot = () => ({
                ...demo.renderer.info.memory,
                sceneObjects: (() =>
                {
                    let objects = 0
                    demo.scene.traverse(() => objects++)
                    return objects
                })(),
                jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
            })

            restart()
            await simulation.readCounts()
            const before = snapshot()
            let detached = 0

            for(let cycle = 0; cycle < cycles; cycle++)
            {
                shake()
                advance(360)
                const counts = await simulation.readCounts()
                detached += counts.falling + counts.growing
            }

            const after = snapshot()
            const stable = Object.keys(before)
                .filter((key) => key !== 'jsHeapMB')
                .every((key) => before[key] === after[key])

            return { pass: stable && detached > 0, cycles, before, after }
        })
    }
}
