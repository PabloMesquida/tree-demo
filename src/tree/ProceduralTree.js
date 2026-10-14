import * as THREE from 'three/webgpu'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { createRandom } from '../utils/random.js'
import { buildTreeAsset } from './TreeAsset.js'

/**
 * Provisional tree: a throwaway stand-in for the Blender model.
 *
 * It is deliberately built the same way the GLB is expected to arrive: one
 * armature, bones named trunk_NN / branch_NN_NN whose local +Y runs along the
 * bone (Blender's convention), and a single SkinnedMesh weighted to them.
 * It then goes through the very same buildTreeAsset() scan as a GLB.
 */

const UP = new THREE.Vector3(0, 1, 0)
const RADIAL_SEGMENTS = 7

const pad = (value) => String(value).padStart(2, '0')

export function createProceduralTree(seed)
{
    const random = createRandom(seed * 7919 + 13)

    const root = new THREE.Group()
    root.name = 'tree_root'

    const armature = new THREE.Group()
    armature.name = 'tree_armature'
    root.add(armature)

    // { bone, length, radiusBottom, radiusTop }
    const segments = []

    const addBone = (name, parent, offsetAlongParent, quaternion, length, radiusBottom, radiusTop) =>
    {
        const bone = new THREE.Bone()
        bone.name = name
        bone.position.set(0, offsetAlongParent, 0)
        bone.quaternion.copy(quaternion)
        parent.add(bone)
        segments.push({ bone, length, radiusBottom, radiusTop })
        return bone
    }

    // Rotation that tilts a bone away from its parent's axis by `tilt`,
    // towards the azimuth `azimuth` around that axis.
    const tiltQuaternion = (tilt, azimuth) =>
        new THREE.Quaternion()
            .setFromAxisAngle(UP, azimuth)
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -tilt))

    // Trunk
    const trunkBones = []
    const trunkLength = 0.9
    const trunkRadii = [0.17, 0.14, 0.115, 0.09, 0.065]
    for(let i = 0; i < 4; i++)
    {
        const lean = i === 0 ? new THREE.Quaternion() : tiltQuaternion(random.range(0.02, 0.07), random.range(0, Math.PI * 2))
        trunkBones.push(addBone(
            `trunk_${pad(i + 1)}`,
            i === 0 ? armature : trunkBones[i - 1],
            i === 0 ? 0 : trunkLength,
            lean,
            trunkLength,
            trunkRadii[i],
            trunkRadii[i + 1]
        ))
    }

    // Main branches, each with one secondary branch
    const branchCount = 8
    for(let b = 0; b < branchCount; b++)
    {
        const progress = b / (branchCount - 1)
        const trunkIndex = 1 + Math.min(2, Math.floor(progress * 3))
        const azimuth = b * 2.399963 + random.range(-0.3, 0.3) // golden angle spread
        const tilt = THREE.MathUtils.lerp(1.25, 0.6, progress) + random.range(-0.12, 0.12)
        const baseRadius = THREE.MathUtils.lerp(0.06, 0.04, progress)
        const baseLength = THREE.MathUtils.lerp(0.72, 0.5, progress) * random.range(0.9, 1.1)

        let parent = trunkBones[trunkIndex]
        let offset = trunkLength * random.range(0.25, 0.95)
        let middleBone = null

        for(let s = 0; s < 3; s++)
        {
            const quaternion = s === 0
                ? tiltQuaternion(tilt, azimuth)
                : tiltQuaternion(random.range(0.1, 0.3), random.range(0, Math.PI * 2))
            const length = baseLength * (1 - s * 0.12)
            const bone = addBone(
                `branch_${pad(b + 1)}_${pad(s + 1)}`,
                parent,
                offset,
                quaternion,
                length,
                baseRadius * (1 - s * 0.28),
                baseRadius * (1 - (s + 1) * 0.28)
            )
            if(s === 1) middleBone = { bone, length }
            parent = bone
            offset = length
        }

        // Secondary branch: still a `branch` bone, just deeper in the hierarchy
        parent = middleBone.bone
        offset = middleBone.length * random.range(0.2, 0.7)
        for(let s = 0; s < 2; s++)
        {
            const quaternion = s === 0
                ? tiltQuaternion(random.range(0.7, 1.0), random.range(0, Math.PI * 2))
                : tiltQuaternion(random.range(0.1, 0.3), random.range(0, Math.PI * 2))
            const length = baseLength * 0.55 * (1 - s * 0.15)
            parent = addBone(
                `branch_${pad(b + 1)}b_${pad(s + 1)}`,
                parent,
                offset,
                quaternion,
                length,
                baseRadius * 0.45 * (1 - s * 0.35),
                baseRadius * 0.45 * (1 - (s + 1) * 0.35)
            )
            offset = length
        }
    }

    // Geometry: one tapered tube per bone, baked into the bind pose
    root.updateMatrixWorld(true)

    const bones = segments.map((segment) => segment.bone)
    const geometries = segments.map(({ bone, length, radiusBottom, radiusTop }, index) =>
    {
        // Rings at 0, 35% and 100% of the bone. The first ring is rigidly
        // weighted to the parent so the joint stays closed; the rest of the
        // segment belongs to the bone itself.
        const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, RADIAL_SEGMENTS, 2, true)
        geometry.translate(0, length * 0.5, 0)

        const position = geometry.attributes.position
        const parentIndex = bones.indexOf(bone.parent)
        const skinIndex = new Uint16Array(position.count * 4)
        const skinWeight = new Float32Array(position.count * 4)

        for(let v = 0; v < position.count; v++)
        {
            const y = position.getY(v)
            if(Math.abs(y - length * 0.5) < 1e-5) position.setY(v, length * 0.35)

            const onFirstRing = y < 1e-5
            skinIndex[v * 4] = onFirstRing && parentIndex !== -1 ? parentIndex : index
            skinWeight[v * 4] = 1
        }

        geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4))
        geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4))
        geometry.applyMatrix4(bone.matrixWorld)

        return geometry
    })

    const geometry = mergeGeometries(geometries)
    geometry.computeVertexNormals()
    for(const part of geometries) part.dispose()

    const material = new THREE.MeshLambertNodeMaterial({ color: 0x6b4a34 })
    const mesh = new THREE.SkinnedMesh(geometry, material)
    mesh.name = 'tree'
    root.add(mesh)
    mesh.bind(new THREE.Skeleton(bones))

    return buildTreeAsset(root, `árbol provisional (semilla ${seed})`)
}
