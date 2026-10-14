import * as THREE from 'three/webgpu'

/**
 * The five leaf textures. Each one is a conifer sprig on a transparent
 * background, stem at the bottom centre, cut from recursos/ramas_referencia.webp
 * by tools/blender/make_leaf_textures.py.
 *
 * The keys are the ones used by `leafTextureDistribution` in config.js.
 */
export const LEAF_TEXTURES = {
    variant1: './textures/leaf_variant_1.webp', // dark green, dense
    variant2: './textures/leaf_variant_2.webp', // olive green, thin and sparse
    variant3: './textures/leaf_variant_3.webp', // blue green, compact
    variant4: './textures/leaf_variant_4.webp', // green and yellow, dry
    variant5: './textures/leaf_variant_5.webp' // grey green, cold and aged
}

/**
 * Loads all of them once. They are shared by the single leaf material.
 */
export async function loadLeafTextures()
{
    const loader = new THREE.TextureLoader()

    return Promise.all(Object.entries(LEAF_TEXTURES).map(async ([key, url]) =>
    {
        try
        {
            const texture = await loader.loadAsync(url)
            texture.colorSpace = THREE.SRGBColorSpace
            texture.name = key
            return texture
        }
        catch(error)
        {
            throw new Error(`No se ha podido cargar la textura de hoja "${url}".`)
        }
    }))
}
