/**
 * Web Threads, ported to SkSL and anchored to the orb.
 *
 * The reference is the ReactBits `WebThreads` background: glowing sine threads
 * woven through a luminous convergence point, drawn in one WebGL2 fragment
 * shader. React Native cannot host that shader — there is no WebGL canvas — so
 * the fragment math is translated to SkSL and driven through the same
 * `RuntimeEffect` path the rest of the orb already uses.
 *
 * The reference is a full-screen wallpaper. Dropped behind the lens unchanged
 * it reads as exactly that: a background the sphere happens to sit on top of.
 * Two adaptations make it part of the orb:
 *
 * - Coordinates are the sphere's own. `(xy - center) / radius` replaces
 *   screen-space `uv`, so the threads converge on the orb, flare at a fixed
 *   angle relative to its size, and fade out radially. Nothing in the field
 *   depends on the canvas, so the same orb renders identically at any size.
 * - `WEB_THREADS_RIM_SKSL` samples the same field on the shell's rim, so the
 *   glass catches warm caustics where a thread crosses it.
 * - `WEB_THREADS_REFRACTION_SKSL` samples the same field *inside* the lens at
 *   compressed coordinates, so a magnified copy of the threads is visible
 *   through the glass. Without it the threads stop at the silhouette and the
 *   sphere reads as an opaque ball pasted over a background.
 *
 * All three shaders share `WEB_THREADS_HELPERS` and `WEB_THREADS_TUNING` so they
 * can never drift: every pass is the same field, evaluated somewhere else.
 *
 * Other porting decisions:
 * - `uMouse*`, fan mode, light-mode replacement, and grain are gone. A phone
 *   has no hover, the orb composites over a transparent canvas, and grain is a
 *   per-pixel hash the orb's own particle layer already covers.
 * - `iTime` is the orb's dedicated thread phase in radians, already scaled by
 *   `timeScale` and wrapped at 2π. Every term is a whole-number harmonic of
 *   that phase, so the seam is invisible.
 * - `uEnergy` (microphone energy) brightens and spreads the threads the way
 *   the microphone used to open the silk ribbon.
 *
 * Output is premultiplied, matching every other pass in this directory.
 */

/**
 * Shared tuning for every pass that samples the thread field. One source means
 * the rear field, the rim caustic, and the refraction through the glass can
 * never disagree about where a thread is.
 *
 * Values are in orb-radius units. The reference's full-screen values fan the
 * outer threads off a band this short, so spread, taper and frequency are all
 * reduced and the count raised to keep the field reading as a woven web.
 */
export const WEB_THREADS_TUNING = {
  threadCount: 6,
  frequency: 4,
  spread: 0.4,
  taper: 0,
  glow: 0.02,
  falloff: 0.6,
  thickness: 1.0,
  brightness: 2.5,
  /**
   * Slow-down applied when the orb accumulates the thread phase. The phase is
   * driven at the ribbon's speed, which was tuned for a single narrow bundle;
   * the same rate across a whole woven field reads as a fast liquid slosh. The
   * orb applies this factor before wrapping, so the shader's `iTime` and the
   * 2π seam stay in step.
   */
  timeScale: 0.45,
} as const;

/**
 * Shared thread field. Returns accumulated colored glow in rgb and the scalar
 * glow sum in a. `p` is orb-normalized: 0,0 at the sphere center, 1.0 at its
 * radius.
 *
 * The `for` bound is a literal because SkSL requires a constant loop bound, and
 * the count check is an `if` rather than a `break` because `break` is rejected
 * by some drivers.
 */
export const WEB_THREADS_HELPERS = `
float circeThreadGlow(float x, float str, float dist) {
  return dist / pow(max(x, 1e-4), str);
}

float4 circeThreadField(
  float2 p,
  float t,
  float n,
  float frequency,
  float spread,
  float taper,
  float falloff,
  float glow,
  float thickness,
  float4 color1,
  float4 color2,
  float4 color3
) {
  float amplitudeScale = spread * abs(p.x);
  float tauOverN = 6.28318530718 / n;
  float invThickness = 1.0 / max(thickness, 0.01);
  float xFreq = p.x * frequency;
  // Mirror about the center so the two halves weave into each other.
  float mirror = p.x < 0.0 ? 1.0 : -1.0;
  // Colour runs along the thread, not across the fan: warm and bright where the
  // threads converge, cooling to copper as they reach the edges. Every thread
  // shares one gradient, so the field reads as a single woven sheet instead of
  // a set of individually tinted lines.
  float grad = clamp(abs(p.x) / 1.7, 0.0, 1.0);
  float3 col = float3(0.0, 0.0, 0.0);
  float gsum = 0.0;

  for (int idx = 0; idx < 10; idx++) {
    float i = float(idx);
    if (i < n) {
      float amplitude = amplitudeScale * (1.0 + i * taper);
      // A slow, small undulation per thread. Anything faster or larger reads as
      // wobbling jelly rather than a woven web drifting in place. The time
      // coefficient is a whole number so the term repeats every 2π alongside
      // the drift; a fractional coefficient would make the field jump at the
      // phase wrap.
      float shimmer = sin(t + i * 1.3) * 0.12;
      float phase = (t + i * tauOverN) * mirror + shimmer;
      float sdf = abs(p.y + sin(xFreq + phase) * amplitude) * invThickness;
      float g = circeThreadGlow(sdf, falloff, glow);
      col += g * mix(color2.rgb, color1.rgb, grad);
      gsum += g;
    }
  }

  float coreAmt = smoothstep(0.5, 2.2, gsum);
  col = mix(col, color3.rgb * gsum, coreAmt * 0.5);
  return float4(col, gsum);
}
`;

/**
 * The field itself, drawn behind the whole sphere. The opaque base is the only
 * thing that hides a thread, so the silhouette stays clean.
 */
export const WEB_THREADS_FIELD_SKSL = `
uniform float2 center;
uniform float radius;
uniform float iTime;
uniform float uThreadCount;
uniform float uFrequency;
uniform float uSpread;
uniform float uTaper;
uniform float uGlow;
uniform float uFalloff;
uniform float uThickness;
uniform float uBrightness;
uniform float uOpacity;
uniform float uEnergy;
uniform float uFadeNear;
uniform float uFadeFar;
uniform float4 uColor1;
uniform float4 uColor2;
uniform float4 uColor3;

${WEB_THREADS_HELPERS}

half4 main(float2 xy) {
  float2 p = (xy - center) / radius;
  float n = max(uThreadCount, 1.0);
  float4 field = circeThreadField(
    p, iTime, n, uFrequency, uSpread, uTaper, uFalloff, uGlow, uThickness,
    uColor1, uColor2, uColor3
  );

  // The wallpaper becomes part of the object: threads live around the orb and
  // fade out at the canvas edge rather than running off it.
  float radialFade = 1.0 - smoothstep(uFadeNear, uFadeFar, abs(p.x));
  // The fade has to happen *inside* the canvas. p.y reaches about 1.5 at the
  // canvas top and bottom, so a fade that starts past that clips the outer
  // threads into straight horizontal lines — a visible ceiling and floor.
  float verticalFade = 1.0 - smoothstep(0.95, 1.45, abs(p.y));

  float bright = uBrightness * (1.0 + uEnergy * 0.55);
  float alpha =
    clamp(field.a, 0.0, 1.0) * uOpacity * (1.0 + uEnergy * 0.25) * radialFade * verticalFade;
  float3 rgb = field.rgb * bright * alpha;
  return half4(rgb, alpha);
}
`;

/**
 * The same field sampled on the shell. Only the thin rim is drawn, so this is
 * the glass catching the threads, never strands painted across the lens.
 */
export const WEB_THREADS_RIM_SKSL = `
uniform float2 center;
uniform float radius;
uniform float iTime;
uniform float uThreadCount;
uniform float uFrequency;
uniform float uSpread;
uniform float uTaper;
uniform float uGlow;
uniform float uFalloff;
uniform float uThickness;
uniform float uIntensity;
uniform float4 uColor1;
uniform float4 uColor2;
uniform float4 uColor3;

${WEB_THREADS_HELPERS}

half4 main(float2 xy) {
  float2 p = (xy - center) / radius;
  float r = length(p);
  if (r > 1.05) {
    return half4(0.0, 0.0, 0.0, 0.0);
  }

  float n = max(uThreadCount, 1.0);
  float4 field = circeThreadField(
    p, iTime, n, uFrequency, uSpread, uTaper, uFalloff, uGlow, uThickness,
    uColor1, uColor2, uColor3
  );

  // A thin band at the hull. The caustic is brightest where the thread glow is,
  // so it tracks the threads crossing the glass instead of ringing the sphere.
  float rim = smoothstep(0.6, 0.97, r) * (1.0 - smoothstep(0.97, 1.05, r));
  float energy = clamp(field.a, 0.0, 1.0);
  float alpha = energy * rim * uIntensity;
  float3 tint = mix(uColor2.rgb, uColor3.rgb, clamp(field.a * 0.35, 0.0, 1.0));
  return half4(tint * alpha, alpha);
}
`;

/**
 * The same field seen through the lens.
 *
 * Drawn inside the sphere silhouette, over the dark base and interior volume.
 * The glass magnifies what is behind it, so the threads are sampled at
 * compressed coordinates: the copy visible inside the lens is larger than the
 * copy passing behind it, and that size difference is what reads as depth
 * rather than as a second layer.
 */
export const WEB_THREADS_REFRACTION_SKSL = `
uniform float2 center;
uniform float radius;
uniform float iTime;
uniform float uThreadCount;
uniform float uFrequency;
uniform float uSpread;
uniform float uTaper;
uniform float uGlow;
uniform float uFalloff;
uniform float uThickness;
uniform float uIntensity;
uniform float uMagnify;
uniform float uEnergy;
uniform float4 uColor1;
uniform float4 uColor2;
uniform float4 uColor3;

${WEB_THREADS_HELPERS}

half4 main(float2 xy) {
  float2 p = (xy - center) / radius;
  float r = length(p);
  if (r > 1.0) {
    return half4(0.0, 0.0, 0.0, 0.0);
  }

  float2 q = p / uMagnify;
  float n = max(uThreadCount, 1.0);
  float4 field = circeThreadField(
    q, iTime, n, uFrequency, uSpread, uTaper, uFalloff, uGlow, uThickness,
    uColor1, uColor2, uColor3
  );

  // The lens is thickest at its middle, so the refracted threads dim toward the
  // hull and never compete with the rim caustic there.
  float depth = 1.0 - smoothstep(0.55, 1.0, r);
  float energy = clamp(field.a, 0.0, 1.0);
  float alpha = energy * depth * uIntensity * (1.0 + uEnergy * 0.6);
  float3 tint = mix(uColor1.rgb, uColor2.rgb, clamp(field.a * 0.3, 0.0, 1.0));
  return half4(tint * alpha, alpha);
}
`;
