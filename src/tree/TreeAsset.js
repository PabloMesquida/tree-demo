import * as THREE from 'three/webgpu'

/**
 * The tree contract.
 *
 * Both the provisional tree (ProceduralTree.js) and a Blender GLB (GlbTree.js)
 * end up as a plain Object3D hierarchy that is scanned by buildTreeAsset().
 * Nothing downstream (rig, anchors, leaves, picking) knows where the tree came
 * from. The naming rules below are the ones documented in TREE_GLB_SPEC.md.
 *
 *   Bones      name starts with `trunk`   -> ROLE_TRUNK  (stiff, no leaves)
 *              name starts with `branch`  -> ROLE_BRANCH (flexible, carries leaves)
 *              anything else              -> ROLE_STATIC (never animated)
 *   Meshes     SkinnedMesh `collider*`    -> pointer picking only, not rendered
 *              SkinnedMesh `leaf_emitter*`-> anchor sampling only, not rendered
 *              any other SkinnedMesh      -> rendered (+ picking / sampling when
 *                                            no dedicated mesh exists)
 *   Anchors    Object3D `leaf_anchor*` below a bone -> explicit leaf anchor
 */

export const ROLE_STATIC = 0
export const ROLE_TRUNK = 1
export const ROLE_BRANCH = 2

const roleFromName = (name) =>
{
    const lower = name.toLowerCase()
    if(lower.startsWith('trunk')) return ROLE_TRUNK
    if(lower.startsWith('branch')) return ROLE_BRANCH
    return ROLE_STATIC
}

// A Blender object with several materials becomes a Group holding one mesh per
// material, so the meaningful name can be one level up.
const hasPrefix = (object, prefix) =>
    object.name.toLowerCase().startsWith(prefix) ||
    (object.parent !== null && object.parent.name.toLowerCase().startsWith(prefix))

const closestBone = (object) =>
{
    let current = object.parent
    while(current !== null && current.isBone !== true) current = current.parent
    return current
}

export function buildTreeAsset(root, source)
{
    root.updateMatrixWorld(true)

    const bones = []
    const skinnedMeshes = []
    const explicitAnchors = []
    const report = []

    root.traverse((object) =>
    {
        if(object.isBone) bones.push(object)
        else if(object.isSkinnedMesh) skinnedMeshes.push(object)
        else if(object.name.toLowerCase().startsWith('leaf_anchor'))
        {
            if(closestBone(object) !== null) explicitAnchors.push(object)
            else report.push(`"${object.name}" ignorado: un leaf_anchor debe estar emparentado a un hueso.`)
        }
    })

    if(bones.length === 0)
        throw new Error(`El árbol (${source}) no contiene huesos. Se necesita un Armature con huesos trunk*/branch*.`)
    if(skinnedMeshes.length === 0)
        throw new Error(`El árbol (${source}) no contiene ningún SkinnedMesh. Las mallas deben estar vinculadas al Armature con pesos.`)

    // traverse() is depth first, so a parent always comes before its children:
    // the rig relies on that ordering.
    const boneIndex = new Map(bones.map((bone, index) => [bone, index]))
    const parents = new Int16Array(bones.length)
    const roles = new Uint8Array(bones.length)

    for(let i = 0; i < bones.length; i++)
    {
        const parentBone = closestBone(bones[i])
        parents[i] = parentBone === null ? -1 : boneIndex.get(parentBone)
        roles[i] = roleFromName(bones[i].name)
    }

    // Mesh roles
    const colliders = skinnedMeshes.filter((mesh) => hasPrefix(mesh, 'collider'))
    const emitters = skinnedMeshes.filter((mesh) => hasPrefix(mesh, 'leaf_emitter'))
    const rendered = skinnedMeshes.filter((mesh) => !colliders.includes(mesh) && !emitters.includes(mesh))

    for(const mesh of [...colliders, ...emitters]) mesh.visible = false

    for(const mesh of skinnedMeshes)
    {
        // The pose changes every frame, so the bind-pose bounds would be wrong
        // for culling and for the raycaster's early-out test.
        mesh.frustumCulled = false
        mesh.computeBoundingSphere()
        mesh.boundingSphere.radius *= 1.6

        for(const bone of mesh.skeleton.bones)
        {
            if(!boneIndex.has(bone))
                throw new Error(`"${mesh.name}" usa el hueso "${bone.name}", que no cuelga del árbol cargado.`)
        }
    }

    // Size, used to keep the rig response independent of the model scale
    const box = new THREE.Box3()
    for(const mesh of rendered.length > 0 ? rendered : skinnedMeshes)
    {
        mesh.computeBoundingBox()
        box.union(mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld))
    }
    const height = Math.max(box.max.y - box.min.y, 1e-3)

    // Report
    const count = (role) => roles.reduce((sum, value) => sum + (value === role ? 1 : 0), 0)
    report.unshift(
        `Origen: ${source}`,
        `Huesos: ${bones.length} (trunk ${count(ROLE_TRUNK)}, branch ${count(ROLE_BRANCH)}, estáticos ${count(ROLE_STATIC)})`,
        `Mallas: ${rendered.length} visibles, ${colliders.length} collider, ${emitters.length} leaf_emitter`,
        `Anclajes explícitos: ${explicitAnchors.length}`,
        `Altura: ${height.toFixed(2)} m, base en y=${box.min.y.toFixed(2)}`
    )
    if(count(ROLE_BRANCH) === 0)
        report.push('AVISO: ningún hueso empieza por "branch": no habrá hojas ni ramas flexibles.')
    if(count(ROLE_TRUNK) === 0)
        report.push('AVISO: ningún hueso empieza por "trunk": el tronco no se inclinará.')

    const scale = new THREE.Vector3()
    for(const bone of bones)
    {
        bone.getWorldScale(scale)
        if(Math.abs(scale.x - 1) > 1e-3 || Math.abs(scale.y - 1) > 1e-3 || Math.abs(scale.z - 1) > 1e-3)
        {
            report.push(`AVISO: el hueso "${bone.name}" tiene escala ${scale.x.toFixed(3)}, ${scale.y.toFixed(3)}, ${scale.z.toFixed(3)}. Aplica la escala del Armature en Blender.`)
            break
        }
    }

    return {
        source,
        root,
        bones,
        boneIndex,
        parents,
        roles,
        skinnedMeshes: rendered,
        pickMeshes: colliders.length > 0 ? colliders : rendered,
        emitterMeshes: emitters.length > 0 ? emitters : rendered,
        explicitAnchors,
        height,
        groundY: box.min.y,
        report
    }
}
