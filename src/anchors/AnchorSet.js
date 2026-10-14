import * as THREE from 'three/webgpu'
import { createRandom } from '../utils/random.js'
import { ROLE_BRANCH } from '../tree/TreeAsset.js'

/**
 * Leaf anchors: the birth points of the leaves.
 *
 * An anchor is rigidly attached to exactly one bone and stored in that bone's
 * local space, so following the rig is a single matrix product per leaf:
 *
 *     world position    = bone.matrixWorld * anchor.position
 *     world orientation = bone world quaternion * anchor.quaternion
 *
 * The set is plain typed arrays, independent of the particle simulation:
 *
 *     id          index in the arrays (stable for a given tree + seed), or
 *                 the node name for explicit anchors (`names`)
 *     bone        Uint16, index into asset.bones
 *     position    vec3 in the bone's local space
 *     quaternion  leaf frame in the bone's local space: +Y is the direction
 *                 the leaf grows towards, +Z is the normal of its plane
 *
 * Two sources, the second wins when present:
 *   1. sampled on the surface of the skinned meshes (area weighted, seeded)
 *   2. explicit `leaf_anchor*` nodes parented to bones in the GLB
 *
 * Sampled anchors also keep, in bone space, the direction their branch grows
 * towards, the outward direction from the branch axis and the world up. Their
 * orientation is then rebuilt from a few parameters by orientAnchors(), so it
 * can be tuned live. Explicit anchors keep the orientation authored in Blender.
 */

// A surface point only becomes an anchor where one bone clearly dominates the
// skin weights. In the blend zone of a joint the skinned surface moves away
// from any single bone, and a rigidly attached leaf would visibly drift.
const MIN_DOMINANT_WEIGHT = 0.8
const MAX_TRIES = 24

const createSet = (count, source) => ({
    count,
    source,
    names: null,
    bone: new Uint16Array(count),
    position: new Float32Array(count * 3),
    quaternion: new Float32Array(count * 4),
    frame: null // sampled anchors only, see orientAnchors()
})

export function generateAnchors(asset, count, seed)
{
    return asset.explicitAnchors.length > 0
        ? collectExplicitAnchors(asset)
        : sampleSurfaceAnchors(asset, count, seed)
}

/**
 * Anchors authored in Blender as empties parented to bones.
 */
function collectExplicitAnchors(asset)
{
    const nodes = [...asset.explicitAnchors].sort((a, b) => a.name.localeCompare(b.name))
    const set = createSet(nodes.length, 'leaf_anchor* del GLB')
    set.names = nodes.map((node) => node.name)

    const local = new THREE.Matrix4()
    const position = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const scale = new THREE.Vector3()

    nodes.forEach((node, i) =>
    {
        let bone = node.parent
        while(bone.isBone !== true) bone = bone.parent

        local.copy(bone.matrixWorld).invert().multiply(node.matrixWorld)
        local.decompose(position, quaternion, scale)

        set.bone[i] = asset.boneIndex.get(bone)
        position.toArray(set.position, i * 3)
        quaternion.toArray(set.quaternion, i * 4)

        // The empties are only data
        node.visible = false
    })

    return set
}

/**
 * Anchors scattered on the surface of the branches.
 */
function sampleSurfaceAnchors(asset, count, seed)
{
    const random = createRandom(seed * 15485863 + 5)
    const set = createSet(count, 'muestreo de superficie')

    // 1. Collect the triangles that belong to branch bones, in world space
    const triangles = [] // { mesh, a, b, c, area }
    const areas = []
    let totalArea = 0

    const vA = new THREE.Vector3()
    const vB = new THREE.Vector3()
    const vC = new THREE.Vector3()
    const edge1 = new THREE.Vector3()
    const edge2 = new THREE.Vector3()
    const normal = new THREE.Vector3()

    const worldPosition = (mesh, index, target) =>
        mesh.getVertexPosition(index, target).applyMatrix4(mesh.matrixWorld)

    // Area weighted centre of each branch bone's surface: from the bone's head
    // towards it is the way the branch grows, whatever the bone's local axes
    const centres = new Map() // bone index -> [x, y, z, area]

    for(const mesh of asset.emitterMeshes)
    {
        const { index, attributes } = mesh.geometry
        const { skinIndex, skinWeight } = attributes
        const joints = mesh.skeleton.bones.map((bone) => asset.boneIndex.get(bone))
        const triangleCount = (index ? index.count : attributes.position.count) / 3

        mesh.userData.joints = joints

        for(let t = 0; t < triangleCount; t++)
        {
            const a = index ? index.getX(t * 3) : t * 3
            const b = index ? index.getX(t * 3 + 1) : t * 3 + 1
            const c = index ? index.getX(t * 3 + 2) : t * 3 + 2

            const dominant = dominantBone(joints, skinIndex, skinWeight, a, b, c, 1 / 3, 1 / 3)
            if(asset.roles[dominant.bone] !== ROLE_BRANCH) continue

            worldPosition(mesh, a, vA)
            worldPosition(mesh, b, vB)
            worldPosition(mesh, c, vC)
            const area = normal.crossVectors(edge1.subVectors(vB, vA), edge2.subVectors(vC, vA)).length() * 0.5
            if(area <= 0) continue

            totalArea += area
            triangles.push({ mesh, a, b, c })
            areas.push(totalArea)

            const centre = centres.get(dominant.bone) || [0, 0, 0, 0]
            centre[0] += (vA.x + vB.x + vC.x) / 3 * area
            centre[1] += (vA.y + vB.y + vC.y) / 3 * area
            centre[2] += (vA.z + vB.z + vC.z) / 3 * area
            centre[3] += area
            centres.set(dominant.bone, centre)
        }
    }

    if(triangles.length === 0)
    {
        throw new Error(asset.roles.includes(ROLE_BRANCH)
            ? 'No hay superficie donde sembrar hojas: ninguna cara está pesada mayoritariamente a un hueso "branch*".'
            : 'Ningún hueso del archivo se llama "branch*", así que no hay ramas donde sembrar hojas. ' +
              'Si el GLB se comprimió con gltfpack, repite la compresión con la opción -kn para conservar los nombres de los nodos.')
    }

    // 2. Pick points, area weighted
    const boneInverse = new Map()
    const inverseOf = (boneIndex) =>
    {
        if(!boneInverse.has(boneIndex))
            boneInverse.set(boneIndex, asset.bones[boneIndex].matrixWorld.clone().invert())
        return boneInverse.get(boneIndex)
    }

    // Per bone, in its own space: branch direction and world up
    const boneFrames = new Map()
    const frameOf = (boneIndex) =>
    {
        if(boneFrames.has(boneIndex)) return boneFrames.get(boneIndex)

        const bone = asset.bones[boneIndex]
        const inverseRotation = bone.getWorldQuaternion(new THREE.Quaternion()).invert()
        const head = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld)
        const [x, y, z, area] = centres.get(boneIndex)
        const direction = new THREE.Vector3(x / area, y / area, z / area).sub(head)

        // A segment whose centre sits on its head: fall back on the bone's +Y (Blender's bone axis)
        if(direction.lengthSq() < 1e-10) direction.set(0, 1, 0)
        else direction.applyQuaternion(inverseRotation).normalize()

        const frame = { direction, up: new THREE.Vector3(0, 1, 0).applyQuaternion(inverseRotation) }
        boneFrames.set(boneIndex, frame)
        return frame
    }

    set.frame = {
        direction: new Float32Array(count * 3),
        radial: new Float32Array(count * 3),
        up: new Float32Array(count * 3),
        random: new Float32Array(count * 2)
    }

    const point = new THREE.Vector3()
    const radial = new THREE.Vector3()
    const localNormal = new THREE.Vector3()
    const boneQuaternion = new THREE.Quaternion()
    let rejected = 0

    for(let i = 0; i < count; i++)
    {
        let triangle, u, v, dominant

        for(let attempt = 0; attempt < MAX_TRIES; attempt++)
        {
            // Binary search in the cumulative areas
            const target = random() * totalArea
            let low = 0
            let high = areas.length - 1
            while(low < high)
            {
                const middle = (low + high) >> 1
                if(areas[middle] < target) low = middle + 1
                else high = middle
            }
            triangle = triangles[low]

            // Uniform point in the triangle
            const r1 = Math.sqrt(random())
            const r2 = random()
            u = r1 * (1 - r2)
            v = r1 * r2

            const { mesh, a, b, c } = triangle
            const { skinIndex, skinWeight } = mesh.geometry.attributes
            dominant = dominantBone(mesh.userData.joints, skinIndex, skinWeight, a, b, c, u, v)

            if(dominant.weight >= MIN_DOMINANT_WEIGHT && asset.roles[dominant.bone] === ROLE_BRANCH) break
            if(attempt < MAX_TRIES - 1) rejected++
        }

        const { mesh, a, b, c } = triangle
        worldPosition(mesh, a, vA)
        worldPosition(mesh, b, vB)
        worldPosition(mesh, c, vC)
        normal.crossVectors(edge1.subVectors(vB, vA), edge2.subVectors(vC, vA)).normalize()
        point.copy(vA).addScaledVector(edge1, u).addScaledVector(edge2, v)

        // Two random numbers per leaf for the angle and roll scatter. Six are
        // drawn so the sequence, and therefore every anchor position, stays the
        // same as before orientation became tunable.
        const jitter = [random(), random(), random(), random(), random(), random()]

        // To the dominant bone's local space
        const bone = asset.bones[dominant.bone]
        const frame = frameOf(dominant.bone)
        point.applyMatrix4(inverseOf(dominant.bone))

        // Outward from the branch axis (the axis runs through the bone's head)
        radial.copy(point).addScaledVector(frame.direction, -point.dot(frame.direction))
        if(radial.lengthSq() < 1e-10)
        {
            bone.getWorldQuaternion(boneQuaternion).invert()
            radial.copy(localNormal.copy(normal).applyQuaternion(boneQuaternion))
            radial.addScaledVector(frame.direction, -radial.dot(frame.direction))
        }
        radial.normalize()

        set.bone[i] = dominant.bone
        point.toArray(set.position, i * 3)
        frame.direction.toArray(set.frame.direction, i * 3)
        radial.toArray(set.frame.radial, i * 3)
        frame.up.toArray(set.frame.up, i * 3)
        set.frame.random[i * 2] = jitter[0]
        set.frame.random[i * 2 + 1] = jitter[3]
    }

    orientAnchors(set, DEFAULT_ORIENTATION)

    for(const mesh of asset.emitterMeshes) delete mesh.userData.joints

    set.source += ` (${triangles.length} caras de rama, ${rejected} puntos descartados por pesos mezclados)`
    return set
}

/**
 * Leaf orientation, pine style: every leaf leaves its branch towards the tip,
 * opened by `angle` from the branch axis.
 *
 *   angle            degrees between the leaf and its branch (0 = along the
 *                    branch towards the tip, 90 = straight out of the bark)
 *   angleVariation   ± degrees of random scatter on the angle
 *   roll             degrees the leaf turns on its own axis (0 = its face
 *                    looks around the branch, 90 = its face looks outwards)
 *   rollVariation    ± degrees of random scatter on the roll
 *   upward           0..1, how much the leaves bend towards the sky
 *
 * Writes set.quaternion. Does nothing for explicit anchors.
 */
export const DEFAULT_ORIENTATION = { angle: 40, angleVariation: 12, roll: 0, rollVariation: 25, upward: 0.2 }

const _direction = new THREE.Vector3()
const _radial = new THREE.Vector3()
const _up = new THREE.Vector3()
const _grow = new THREE.Vector3()
const _face = new THREE.Vector3()
const _side = new THREE.Vector3()
const _basis = new THREE.Matrix4()
const _quaternion = new THREE.Quaternion()
const _roll = new THREE.Quaternion()

export function orientAnchors(set, { angle, angleVariation, roll, rollVariation, upward })
{
    if(set.frame === null) return false

    const { direction, radial, up, random } = set.frame
    const degrees = Math.PI / 180

    for(let i = 0; i < set.count; i++)
    {
        _direction.fromArray(direction, i * 3)
        _radial.fromArray(radial, i * 3)
        _up.fromArray(up, i * 3)

        // Growth: from the branch axis, opened towards the outside
        const opening = (angle + (random[i * 2] * 2 - 1) * angleVariation) * degrees
        _grow.copy(_direction).multiplyScalar(Math.cos(opening)).addScaledVector(_radial, Math.sin(opening))
        _grow.addScaledVector(_up, upward).normalize()

        // Face: perpendicular to the plane that holds the branch and the leaf, then rolled
        _face.crossVectors(_direction, _grow)
        if(_face.lengthSq() < 1e-8) _face.crossVectors(_radial, _grow)
        _face.normalize()
        _roll.setFromAxisAngle(_grow, (roll + (random[i * 2 + 1] * 2 - 1) * rollVariation) * degrees)
        _face.applyQuaternion(_roll)

        // Leaf plane: +Y grows, +Z is its normal
        _side.crossVectors(_grow, _face)
        _basis.makeBasis(_side, _grow, _face)
        _quaternion.setFromRotationMatrix(_basis).toArray(set.quaternion, i * 4)
    }

    return true
}

// Sum the skin weights per bone at a barycentric point and return the largest.
const _weights = new Map()
const _dominant = { bone: 0, weight: 0 }

function dominantBone(joints, skinIndex, skinWeight, a, b, c, u, v)
{
    _weights.clear()

    const accumulate = (vertex, factor) =>
    {
        for(let k = 0; k < 4; k++)
        {
            const weight = skinWeight.getComponent(vertex, k) * factor
            if(weight <= 0) continue
            const bone = joints[skinIndex.getComponent(vertex, k)]
            _weights.set(bone, (_weights.get(bone) || 0) + weight)
        }
    }

    accumulate(a, 1 - u - v)
    accumulate(b, u)
    accumulate(c, v)

    let total = 0
    _dominant.bone = 0
    _dominant.weight = 0
    for(const [bone, weight] of _weights)
    {
        total += weight
        if(weight > _dominant.weight)
        {
            _dominant.bone = bone
            _dominant.weight = weight
        }
    }
    if(total > 0) _dominant.weight /= total

    return _dominant
}
