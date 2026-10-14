import * as THREE from 'three/webgpu'

/**
 * The per-bone data that goes to the GPU, refreshed once per frame right
 * after the rig has posed the bones and before anything is computed or drawn.
 *
 *   matrices     the bones' own matrixWorld objects (live references)
 *   quaternions  world orientation of each bone
 *   shakes       the rig's shake values, rad/s (live reference)
 *
 * Because the skinned mesh and the leaves read the same matrixWorld values in
 * the same frame, anchors cannot lag behind the branches.
 */

const _position = new THREE.Vector3()
const _scale = new THREE.Vector3()

export class BoneState
{
    constructor(asset, rig)
    {
        this.asset = asset
        this.matrices = asset.bones.map((bone) => bone.matrixWorld)
        this.quaternions = asset.bones.map(() => new THREE.Quaternion())
        this.shakes = rig.shake

        this.update()
    }

    update()
    {
        const { asset, quaternions } = this

        asset.root.updateMatrixWorld(true)

        for(let i = 0; i < quaternions.length; i++)
            asset.bones[i].matrixWorld.decompose(_position, quaternions[i], _scale)
    }
}
