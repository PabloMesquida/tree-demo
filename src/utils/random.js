/**
 * Seeded PRNG (mulberry32). Everything random on the CPU side goes through
 * this so a given seed always produces the same tree, anchors and rig tuning.
 */
export function createRandom(seed)
{
    let state = (seed >>> 0) || 1

    const random = () =>
    {
        state = (state + 0x6D2B79F5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }

    random.range = (min, max) => min + (max - min) * random()

    return random
}
