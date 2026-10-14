import * as THREE from 'three/webgpu'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Inspector } from 'three/addons/inspector/Inspector.js'
import { color, mix, smoothstep, uv } from 'three/tsl'
import { leafTextureDistribution, options, params } from './config.js'
import { createProceduralTree } from './tree/ProceduralTree.js'
import { loadGlbTree } from './tree/GlbTree.js'
import { BranchRig } from './rig/BranchRig.js'
import { BoneState } from './rig/BoneState.js'
import { generateAnchors, orientAnchors } from './anchors/AnchorSet.js'
import { LeafSimulation } from './leaves/LeafSimulation.js'
import { LeafRenderer } from './leaves/LeafRenderer.js'
import { LEAF_TEXTURES, loadLeafTextures } from './leaves/leafTextures.js'
import { assignVariants } from './leaves/textureVariants.js'
import { PointerInteraction } from './interaction/PointerInteraction.js'
import { DebugUI } from './debug/DebugUI.js'
import { BasicPanel } from './ui/BasicPanel.js'
import { createChecks } from './debug/checks.js'

const MAX_DELTA = 1 / 30

const fail = (message) =>
{
    const element = document.getElementById('fatal')
    element.textContent = message
    element.hidden = false
    document.querySelector('canvas.threejs').style.display = 'none'
}

async function main()
{
    const canvas = document.querySelector('canvas.threejs')

    /**
     * WebGPU, and nothing else. three falls back to WebGL 2 on its own when
     * WebGPU is missing, so it is checked before and after creating the renderer.
     */
    if(!navigator.gpu)
    {
        return fail(
            'WebGPU no está disponible en este navegador.\n\n' +
            'Esta demo simula las hojas con compute shaders y no tiene modo WebGL.\n' +
            'Prueba con una versión reciente de Chrome o Edge, en https:// o en localhost.'
        )
    }

    const adapter = await navigator.gpu.requestAdapter()
    if(adapter === null)
    {
        return fail(
            'El navegador expone WebGPU, pero no ha encontrado ningún adaptador gráfico compatible.\n\n' +
            'Revisa que la aceleración por hardware esté activada y que los drivers de la GPU estén al día.'
        )
    }

    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
    if(options.debug) renderer.inspector = new Inspector()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    await renderer.init()

    if(renderer.backend.isWebGPUBackend !== true)
        return fail('El renderer no ha podido arrancar con WebGPU y ha intentado usar WebGL. La demo se detiene: necesita cómputo en GPU.')

    /**
     * Scene
     */
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1b2126)

    const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100)

    scene.add(new THREE.HemisphereLight(0xdfeaff, 0x3a3226, 1.6))
    const sun = new THREE.DirectionalLight(0xfff1dd, 2.2)
    sun.position.set(3, 6, 4)
    scene.add(sun)

    /**
     * Tree: provisional or GLB, same contract either way (see TreeAsset.js)
     */
    let asset
    try
    {
        asset = options.tree === 'glb' ? await loadGlbTree(options.glb) : createProceduralTree(options.seed)
    }
    catch(error)
    {
        console.error(error)
        return fail(`No se ha podido preparar el árbol.\n\n${error.message}`)
    }

    scene.add(asset.root)
    for(const mesh of asset.skinnedMeshes)
    {
        mesh.castShadow = true
        mesh.receiveShadow = true
    }
    console.info(`[tree]\n  ${asset.report.join('\n  ')}`)

    // Ground: a lighter pool under the tree that darkens outwards and fades
    // into the background, so the floor has no visible edge
    const groundMaterial = new THREE.MeshLambertNodeMaterial({ transparent: true, depthWrite: false })
    const groundDistance = uv().sub(0.5).length().mul(2) // 0 at the centre, 1 at the rim
    groundMaterial.colorNode = mix(color(0x47525a), color(0x283036), smoothstep(0, 0.55, groundDistance))
    groundMaterial.opacityNode = smoothstep(0.45, 1, groundDistance).oneMinus()

    const ground = new THREE.Mesh(
        new THREE.CircleGeometry(asset.height * 3, 96).rotateX(-Math.PI * 0.5),
        groundMaterial
    )
    ground.renderOrder = -1
    ground.position.y = asset.groundY
    ground.receiveShadow = true
    scene.add(ground)

    // Shadows: the sun keeps its direction; its shadow camera is fitted to the tree
    const centre = new THREE.Vector3(0, asset.groundY + asset.height * 0.5, 0)
    sun.target.position.copy(centre)
    sun.position.copy(centre).addScaledVector(new THREE.Vector3(3, 6, 4).normalize(), asset.height * 2)
    scene.add(sun.target)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -asset.height * 0.9
    sun.shadow.camera.right = asset.height * 0.9
    sun.shadow.camera.top = asset.height * 0.9
    sun.shadow.camera.bottom = -asset.height * 0.9
    sun.shadow.camera.near = asset.height * 0.5
    sun.shadow.camera.far = asset.height * 3.5
    sun.shadow.radius = 3
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = asset.height * 0.004

    camera.position.set(0, asset.groundY + asset.height * 0.62, asset.height * 2.3)
    const controls = new OrbitControls(camera, canvas)
    controls.target.set(0, asset.groundY + asset.height * 0.5, 0)
    controls.enableDamping = true
    controls.maxPolarAngle = Math.PI * 0.52
    controls.update()

    /**
     * Rig -> anchors -> particles
     */
    let anchors
    try
    {
        // Anchors for the full capacity. They are independent random samples, so
        // the first N of them are an even spread too: showing fewer leaves just
        // shows a prefix
        anchors = generateAnchors(asset, options.capacity, options.seed)
    }
    catch(error)
    {
        console.error(error)
        return fail(`No se han podido generar los anclajes de las hojas.\n\n${error.message}`)
    }
    console.info(`[anchors] ${anchors.count} anclajes, ${anchors.source}`)

    // Explicit anchors in a GLB fix the capacity: there cannot be more leaves than anchors
    params.leafCount = Math.min(params.leafCount, anchors.count)

    const rig = new BranchRig(asset, options.seed)
    const boneState = new BoneState(asset, rig)
    const simulation = new LeafSimulation(renderer, anchors, boneState, options.seed)
    let leafTextures
    try
    {
        leafTextures = await loadLeafTextures()
    }
    catch(error)
    {
        console.error(error)
        return fail(error.message)
    }
    const variantKeys = Object.keys(LEAF_TEXTURES)
    const leafVariants = assignVariants(anchors.count, leafTextureDistribution, variantKeys, options.seed)
    const variantCounts = variantKeys.map((key, index) => `${key} ${leafVariants.reduce((sum, v) => sum + (v === index ? 1 : 0), 0)}`)
    console.info(`[leaves] texturas por hoja: ${variantCounts.join(', ')}`)

    const leafRenderer = new LeafRenderer(simulation, boneState, leafTextures, leafVariants)
    leafRenderer.leaves.castShadow = true
    leafRenderer.leaves.receiveShadow = true
    scene.add(leafRenderer.leaves, leafRenderer.anchors)

    const pointer = new PointerInteraction(canvas, camera, asset, rig)

    /**
     * Parameters -> rig, uniforms, visibility
     */
    let orientationKey = ''

    const applyParams = () =>
    {
        // Leaf orientation: rebuilt only when one of its parameters changed
        const orientation = {
            angle: params.leafAngle,
            angleVariation: params.leafAngleVariation,
            roll: params.leafRoll,
            rollVariation: params.leafRollVariation,
            upward: params.leafUpward
        }
        const key = JSON.stringify(orientation)
        if(key !== orientationKey && orientAnchors(anchors, orientation))
            simulation.setAnchorQuaternions(anchors.quaternion)
        orientationKey = key

        const u = simulation.uniforms
        const angle = THREE.MathUtils.degToRad(params.windAngle)

        simulation.setActiveCount(params.leafCount)
        leafRenderer.leaves.count = simulation.count
        leafRenderer.anchors.count = simulation.count

        rig.enabled = params.treeMotion
        rig.strength = params.motionStrength

        u.fallEnabled.value = params.leafFall ? 1 : 0
        u.regenEnabled.value = params.regeneration ? 1 : 0
        u.detachProbability.value = params.detachProbability
        u.detachThreshold.value = params.detachThreshold
        u.gripSpread.value = params.gripVariation
        u.gravity.value = params.gravity
        u.wind.value.set(Math.cos(angle), 0, -Math.sin(angle)).multiplyScalar(params.windStrength)
        u.growDuration.value = params.growDuration
        u.groundY.value = asset.groundY

        leafRenderer.uniforms.size.value = params.leafSize * (asset.height / 3.6)
        leafRenderer.uniforms.stateColors.value = params.stateColors ? 1 : 0
        leafRenderer.anchors.visible = params.showAnchors
        sun.castShadow = params.shadows
    }

    const reset = () =>
    {
        rig.reset()
        simulation.reset()
    }

    applyParams()

    // Full settings with #debug, only the basics without it. Adding or removing
    // #debug reloads the page, since the two interfaces are built once.
    const ui = options.debug
        ? new DebugUI({ renderer, asset, anchors, rig, simulation, leafRenderer, pointer, onChange: applyParams, onReset: reset })
        : new BasicPanel({ rig, simulation, onChange: applyParams, onReset: reset })
    window.addEventListener('hashchange', () => window.location.reload())

    /**
     * Resize
     */
    window.addEventListener('resize', () =>
    {
        camera.aspect = window.innerWidth / window.innerHeight
        camera.updateProjectionMatrix()
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.setSize(window.innerWidth, window.innerHeight)
    })

    /**
     * Loop. The order is what keeps the rig and the GPU buffers in step:
     *   1. pointer  -> pushes on the rig (ray cast against last frame's pose)
     *   2. rig      -> bone quaternions for this frame
     *   3. leaves   -> bone matrices to the GPU, then the compute pass
     *   4. render   -> skinned mesh and leaves drawn from the same bone matrices
     */
    const timer = new THREE.Timer()
    timer.connect(document)

    const state = { paused: false }

    renderer.setAnimationLoop(() =>
    {
        timer.update()
        const deltaTime = Math.min(timer.getDelta(), MAX_DELTA)

        controls.update()

        if(!state.paused)
        {
            pointer.update(deltaTime)
            rig.update(deltaTime)
            simulation.step(deltaTime)
        }

        renderer.render(scene, camera)
        ui.update(deltaTime)
    })

    // Console access and scripted checks: `demo.checks.determinism()`, etc.
    window.demo = { renderer, scene, camera, asset, anchors, rig, boneState, simulation, leafRenderer, leafTextures, leafVariants, pointer, params, applyParams, reset, state }
    window.demo.checks = createChecks(window.demo)
}

main()
