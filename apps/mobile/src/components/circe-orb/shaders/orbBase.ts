/**
 * Dark absorptive base pass.
 *
 * This is the *first* of two sphere passes and it is deliberately opaque. It
 * establishes the heavy dark body that the reference is built around: the
 * centre absorbs light and only the hull picks up any warmth.
 *
 * There is no directional light term here on purpose. An earlier version
 * reconstructed a normal and lit the sphere from the upper-left, which is
 * physically reasonable and produces a polished orange ball. The design calls
 * for the opposite: almost no light in the middle.
 *
 * Uniforms are tuples so the worklet never parses a hex string.
 */
export const ORB_BASE_SKSL = `
uniform float2 center;
uniform float radius;
uniform float coreWarmth;
uniform float energy;
uniform float4 coreColor;
uniform float4 coreWarmColor;
uniform float4 emberColor;

half4 main(float2 xy) {
  float2 uv = (xy - center) / radius;
  float r = length(uv);
  if (r > 1.0) {
    return half4(0.0);
  }

  float z = sqrt(max(0.0, 1.0 - r * r));

  // The body stays in the core family, drifting only slightly warm toward the
  // hull. Microphone energy lifts the warmth a little and nothing else.
  float3 color = mix(coreColor.rgb, coreWarmColor.rgb, smoothstep(0.0, 0.74, r));

  // Still no directional light term — the centre absorbs. But the warmth is not
  // evenly distributed around the hull: it gathers on the side the hull light
  // comes from, which is what stops the dark body reading as a flat disc with a
  // painted ring, and it deepens away from it.
  float keyX = 0.55;
  float lit = 0.5 - 0.5 * (uv.x * keyX - uv.y * 0.83) / 1.0;
  float hull = pow(1.0 - z, 2.4);
  color = mix(color, emberColor.rgb, hull * coreWarmth * (0.55 + 0.35 * lit));
  color = mix(color, emberColor.rgb, hull * energy * 0.28);

  // Limb darkening over the last fifth of the radius. The hull pass lights the
  // very edge, so the body darkening beneath it is what gives the object a
  // silhouette instead of letting body and rim run together.
  color *= mix(1.0, 0.7, smoothstep(0.8, 1.0, r));

  float edge = 1.0 - smoothstep(0.985, 1.0, r);
  return half4(color * edge, edge);
}
`;
