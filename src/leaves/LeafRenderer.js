import * as THREE from 'three/webgpu'
import { Fn, hash, instanceIndex, instancedBufferAttribute, int, mix, normalLocal, positionLocal, select, texture, uniform, uv, vec3, vec4 } from 'three/tsl'
import { createBoneNodes, quatRotate } from '../utils/tsl.js'

/**
 * Draws the leaves and, for debugging, the anchors.
 *
 * Leaves: one instanced Mesh (a plane, two triangles) for all the particles.
 * The vertex shader only reads what the simulation wrote: world position,
 * scale and orientation. It knows nothing about bones or states.
 * Each leaf shows one of the leaf textures, chosen once per leaf and passed as
 * a per-instance attribute: one material and one draw call for all of them.
 *
 * Anchors: instanced sprites placed at bone matrix * anchor, straight from the
 * bone uniforms. They show where a leaf will regrow even while it is away.
 */
export class LeafRenderer
{
    constructor(simulation, boneState, textures, variants)
    {
        this.uniforms = {
            size: uniform(0.17),
            stateColors: uniform(0)
        }

        this.leaves = this.createLeaves(simulation, textures, variants)
        this.anchors = this.createAnchors(simulation, boneState)
    }

    createLeaves(simulation, textures, variants)
    {
        const u = this.uniforms

        // The plane's origin is the bottom edge: the leaf grows out of its anchor
        const geometry = new THREE.PlaneGeometry(0.6, 1)
        geometry.translate(0, 0.5, 0)

        // alphaToCoverage keeps the thin needles visible from afar, where
        // mipmapping averages their alpha below any fixed cutout threshold
        const material = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true })

        material.positionNode = Fn(() =>
        {
            const position = simulation.position.element(instanceIndex)
            const orientation = simulation.orientation.element(instanceIndex)

            // Scale: global size, a fixed per-leaf variation, and the life-cycle scale
            const variation = mix(0.75, 1.25, hash(instanceIndex.add(9176)))
            positionLocal.mulAssign(u.size.mul(variation).mul(position.w))

            // Rotation, applied to the normal too so the shading follows
            positionLocal.assign(quatRotate(orientation, positionLocal))
            normalLocal.assign(quatRotate(orientation, normalLocal))

            // Translation
            positionLocal.addAssign(position.xyz)

            return positionLocal
        })()

        // Debug view: one flat color per state
        const state = simulation.state.element(instanceIndex).x
        const stateColor = select(
            state.lessThan(0.5),
            vec3(0.25, 0.75, 0.2),
            select(state.lessThan(1.5), vec3(1, 0.5, 0.05), vec3(0.2, 0.75, 1))
        )
        // Texture: every variant is sampled and the leaf's own is selected (a
        // select, not a branch, keeps the sampling in uniform control flow)
        const variant = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(variants), 1))
        const samples = textures.map((map) => texture(map, uv()))
        let leafColor = samples[samples.length - 1]
        for(let i = samples.length - 2; i >= 0; i--)
            leafColor = select(variant.lessThan(i + 0.5), samples[i], leafColor)

        // The alpha travels in colorNode so the shadow pass sees it too, and the
        // mask cuts the shadow to the shape of the sprig instead of its rectangle
        material.colorNode = vec4(mix(leafColor.rgb, stateColor.toVertexStage(), u.stateColors), leafColor.a)
        material.alphaTest = 0.5
        material.maskShadowNode = leafColor.a.greaterThan(0.5)

        const mesh = new THREE.Mesh(geometry, material)
        mesh.name = 'leaves'
        mesh.count = simulation.count
        mesh.frustumCulled = false // positions only exist on the GPU

        return mesh
    }

    createAnchors(simulation, boneState)
    {
        const bones = createBoneNodes(boneState)

        const material = new THREE.SpriteNodeMaterial({ color: 0xff2e63, depthTest: false })
        const anchor = simulation.anchorData.element(instanceIndex)
        material.positionNode = bones.matrices.element(int(anchor.w)).mul(vec4(anchor.xyz, 1)).xyz
        material.scaleNode = uniform(0.03)

        const sprite = new THREE.Sprite(material)
        sprite.name = 'leaf_anchors_debug'
        sprite.count = simulation.count
        sprite.frustumCulled = false
        sprite.renderOrder = 10
        sprite.visible = false

        return sprite
    }
}
