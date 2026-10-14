import { Fn, cos, cross, dot, sin, uniformArray, vec4 } from 'three/tsl'

/**
 * Quaternion helpers. Quaternions are vec4(x, y, z, w), like THREE.Quaternion.
 */
export const quatMultiply = Fn(([a, b]) =>
    vec4(
        b.xyz.mul(a.w).add(a.xyz.mul(b.w)).add(cross(a.xyz, b.xyz)),
        a.w.mul(b.w).sub(dot(a.xyz, b.xyz))
    )
)

export const quatRotate = Fn(([q, v]) =>
{
    const t = cross(q.xyz, v).mul(2)
    return v.add(t.mul(q.w)).add(cross(q.xyz, t))
})

export const quatFromAxisAngle = Fn(([axis, angle]) =>
{
    const half = angle.mul(0.5)
    return vec4(axis.mul(sin(half)), cos(half))
})

/**
 * The per-bone data every GPU consumer needs, as uniform arrays.
 *
 * The arrays hold references to objects owned by BoneState, so there is
 * nothing to copy by hand: three re-uploads them whenever the shader that
 * uses the nodes runs. Each shader gets its own set of nodes.
 */
export function createBoneNodes(boneState)
{
    return {
        matrices: uniformArray(boneState.matrices, 'mat4'),
        quaternions: uniformArray(boneState.quaternions, 'vec4'),
        shakes: uniformArray(boneState.shakes, 'float')
    }
}
