import { createRandom } from '../utils/random.js'

/**
 * Weighted choice of a texture variant per leaf.
 *
 * The distribution is an object of non-negative weights, one per variant key
 * (see `leafTextureDistribution` in config.js). Weights are percentages by
 * convention but do not need to add up to 100: they are normalised, so
 * { a: 3, b: 1 } means 75 % / 25 %. A weight of 0 is never picked.
 *
 * An invalid distribution (negative or non-numeric weights, unknown keys, all
 * zeros) is reported in the console and replaced by equal weights, so the demo
 * keeps running.
 */

export function normalizeDistribution(distribution, keys)
{
    const problems = []

    for(const key of Object.keys(distribution))
        if(!keys.includes(key)) problems.push(`variante desconocida "${key}"`)

    const weights = keys.map((key) =>
    {
        const value = distribution[key] ?? 0
        if(typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        {
            problems.push(`"${key}" = ${value} (debe ser un número >= 0)`)
            return 0
        }
        return value
    })

    const total = weights.reduce((sum, weight) => sum + weight, 0)
    if(total <= 0) problems.push('todos los porcentajes son 0')

    if(problems.length > 0)
    {
        console.error(`[leaves] Distribución de texturas no válida: ${problems.join('; ')}. Se usan pesos iguales.`)
        return keys.map(() => 1 / keys.length)
    }

    return weights.map((weight) => weight / total)
}

/**
 * Returns a function that maps a random number in [0, 1) to a variant index.
 */
export function createWeightedPicker(probabilities)
{
    const cumulative = []
    let sum = 0
    for(const probability of probabilities)
    {
        sum += probability
        cumulative.push(sum)
    }

    return (random) =>
    {
        const target = random * sum
        for(let i = 0; i < cumulative.length; i++)
        {
            // Strict comparison: a zero weight adds nothing to the running sum and can never win
            if(probabilities[i] > 0 && target < cumulative[i]) return i
        }
        // Rounding at the very top of the range: last variant with a non-zero weight
        return probabilities.findLastIndex((probability) => probability > 0)
    }
}

/**
 * One variant per leaf, decided once. The same seed always gives the same
 * assignment, so a leaf keeps its texture for the whole session and across
 * reloads.
 */
export function assignVariants(count, distribution, keys, seed)
{
    const pick = createWeightedPicker(normalizeDistribution(distribution, keys))
    const random = createRandom(seed * 92821 + 17)
    const variants = new Uint8Array(count)

    for(let i = 0; i < count; i++) variants[i] = pick(random())

    return variants
}
