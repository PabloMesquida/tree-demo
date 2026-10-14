/**
 * Options that need a page reload (they size the GPU buffers or pick the tree)
 * come from the URL:  ?count=2000&maxCount=20000&seed=7&tree=glb&glb=./models/test_tree.glb
 *
 * count     leaves shown when the page opens
 * maxCount  how many leaves the GPU buffers hold: the most the panel slider can show
 */
const query = new URLSearchParams(window.location.search)

const intOption = (name, fallback, min, max) =>
{
    const value = parseInt(query.get(name), 10)
    return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback
}

// What the demo shows when the URL says nothing
const DEFAULT_TREE = 'glb' // 'glb' or 'procedural'
const DEFAULT_GLB = './models/sapling_test12_b.glb'

const count = intOption('count', 5000, 0, 200000)

export const options = {
    // #debug in the URL shows every setting, the counters and the profiler
    debug: window.location.hash.toLowerCase() === '#debug',
    count,
    capacity: Math.max(count, intOption('maxCount', 10000, 1, 200000)),
    seed: intOption('seed', 1, 0, 0x7fffffff),
    tree: ['glb', 'procedural'].includes(query.get('tree')) ? query.get('tree') : DEFAULT_TREE,
    glb: query.get('glb') || DEFAULT_GLB
}

/**
 * How often each leaf texture appears (textures listed in leaves/leafTextures.js).
 * Each leaf picks one when the page loads and keeps it. The numbers are
 * percentages; if they do not add up to 100 they are scaled proportionally.
 * 0 disables a variant. Negative values or all zeros fall back to equal shares.
 */
export const leafTextureDistribution = {
    variant1: 30, // dark green, dense
    variant2: 25, // olive green, thin and sparse
    variant3: 20, // blue green, compact
    variant4: 15, // green and yellow, dry
    variant5: 10 // grey green, cold and aged
}

/**
 * Live parameters, tweakable from the debug UI.
 */
export const params = {
    // Tree
    treeMotion: true,
    motionStrength: 1,

    // Leaves
    leafCount: count, // leaves shown, from 0 to options.capacity
    leafFall: true,
    regeneration: true,
    detachProbability: 0.25, // chance per decision tick for a leaf whose branch shakes past its grip
    detachThreshold: 0.5, // branch shake (rad/s) under which no leaf lets go
    gripVariation: 0.5, // each leaf needs between 1x and (1 + this)x the threshold: low enough that every leaf can fall
    gravity: 4,
    windStrength: 0.6,
    windAngle: 20, // degrees around Y, 0 = +X
    growDuration: 1.5,
    leafSize: 0.17,

    // Leaf orientation (sampled anchors), see orientAnchors() in anchors/AnchorSet.js
    leafAngle: 40, // degrees from the branch axis: 0 = along the branch, 90 = straight out
    leafAngleVariation: 12,
    leafRoll: 0, // degrees around the leaf's own axis
    leafRollVariation: 25,
    leafUpward: 0.2, // 0..1, bend towards the sky

    // Debug
    shadows: true,
    showAnchors: false,
    stateColors: false
}
