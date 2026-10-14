import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { buildTreeAsset } from './TreeAsset.js'

/**
 * Loads a rigged tree exported from Blender. All the requirements on the file
 * are the ones enforced by buildTreeAsset() and described in TREE_GLB_SPEC.md.
 *
 * The file may be compressed with meshopt (EXT_meshopt_compression, with or
 * without quantized attributes): the decoder only runs when a file needs it.
 */
export async function loadGlbTree(url)
{
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)

    let gltf
    try
    {
        gltf = await loader.loadAsync(url)
    }
    catch(error)
    {
        // A missing file comes back as the dev server's index.html, hence the odd parse errors
        throw new Error(`No se ha podido cargar "${url}". Comprueba que el archivo existe en public/models/ y que el nombre coincide.\n(${error.message})`)
    }

    if(gltf.animations.length > 0)
        console.warn(`[tree] ${url} trae ${gltf.animations.length} animaciones; la demo las ignora y mueve los huesos por código.`)

    return buildTreeAsset(gltf.scene, url)
}
