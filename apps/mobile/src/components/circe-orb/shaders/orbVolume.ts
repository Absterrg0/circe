/**
 * Interior volume pass.
 *
 * The missing layer. `OrbBase` is deliberately near-black, and `OrbShell` only
 * lights the hull, so between them the sphere was rendering as a flat black
 * disc. This pass puts *volume* between those two: broad, low-frequency copper
 * illumination occupying the outer 40-50% of the sphere, plus two asymmetric
 * warm lobes.
 *
 * It must never produce the old central white hotspot. The core stays dark and
 * the light only ever reaches copper and a restrained peach, never white. The
 * alpha ceiling is 0.42 so the pass reads as smoked glass, not as a second
 * opaque sphere.
 *
 * Order in the composition is base, volume, shell. The ribbon is behind the
 * whole sphere, so nothing in this pass competes with strands.
 */
export const ORB_VOLUME_SKSL = `
uniform float2 center;
uniform float radius;
uniform float volumeIntensity;
uniform float energy;
uniform float4 deepColor;
uniform float4 copperColor;
uniform float4 peachColor;

half4 main(float2 xy) {
  float2 uv = (xy - center) / radius;
  float r = length(uv);
  if (r > 1.0) {
    return half4(0.0);
  }

  // Broad field hugging the inside of the hull. This is the bulk of the
  // volume, and it is why the sphere is not a black disc.
  float edgeField = smoothstep(0.55, 0.99, r);

  // Three asymmetric lobes: a lower-body glow, a left-side light, and a key
  // reflection high on the lit side. The reference lighting is not radially
  // symmetric, and without the key term the outer field alone reads as a ring
  // rather than as light collecting on a surface.
  float lowerGlow = exp(
    -pow((uv.x - 0.12) / 0.78, 2.0) - pow((uv.y - 0.34) / 0.55, 2.0)
  );
  float sideGlow = exp(
    -pow((uv.x + 0.52) / 0.42, 2.0) - pow((uv.y + 0.08) / 0.70, 2.0)
  );
  float keyGlow = exp(
    -pow((uv.x + 0.55) / 0.36, 2.0) - pow((uv.y + 0.72) / 0.34, 2.0)
  );

  // Every lobe is pushed out toward the hull on purpose, and masked again by
  // radius so none of them can light the middle. The centre of this object
  // absorbs light; letting the volume reach it is what turns the lens into a
  // copper coin, which is the one failure the palette notes call out by name.
  float hullMask = smoothstep(0.48, 0.92, r);
  float warm =
    edgeField * 0.30 + (lowerGlow * 0.16 + sideGlow * 0.12 + keyGlow * 0.18) * hullMask;
  warm *= volumeIntensity * (1.0 + energy * 0.40);

  // Read through deep copper into copper, with peach only at the strongest
  // lobes. White is never reached here.
  float3 color = mix(deepColor.rgb, copperColor.rgb, smoothstep(0.0, 0.8, warm));
  color = mix(color, peachColor.rgb, smoothstep(0.7, 1.0, warm) * 0.5);

  float alpha = clamp(warm, 0.0, 0.40);
  float edge = 1.0 - smoothstep(0.985, 1.0, r);
  return half4(color * alpha * edge, alpha * edge);
}
`;
