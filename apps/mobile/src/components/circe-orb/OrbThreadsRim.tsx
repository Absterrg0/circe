import { useMemo } from "react";
import { Circle, Shader, Skia } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_APPEARANCE, ORB_PALETTE, rgbaOf, type OrbAppearance } from "./orbTokens";
import type { OrbAnimatedParams } from "./orbTransition";
import { WEB_THREADS_RIM_SKSL, WEB_THREADS_TUNING } from "./shaders/webThreads";

/**
 * The thread caustic on the glass.
 *
 * Drawn over the shell in the threads field mode. It evaluates the exact same
 * field as `OrbWebThreadsField` and keeps only a thin band at the hull, so the
 * glass appears to catch warm light where a thread crosses it. Without this the
 * thread field and the sphere read as two separate layers stacked together: the
 * threads pass behind an opaque ball and nothing on the ball acknowledges them.
 *
 * The pass is deliberately weak. It is a highlight, not a second ribbon, and it
 * must never put strands across the lens body.
 */
export function OrbThreadsRim({
  centerX,
  centerY,
  radius,
  phaseSV,
  energySV,
  params,
  appearance,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly phaseSV: SharedValue<number>;
  readonly energySV: SharedValue<number>;
  readonly params: OrbAnimatedParams;
  readonly appearance: OrbAppearance;
}) {
  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(WEB_THREADS_RIM_SKSL);
    } catch {
      return null;
    }
  }, []);

  const colors = useMemo(
    () => ({
      copper: rgbaOf(ORB_PALETTE.copper),
      peach: rgbaOf(ORB_PALETTE.peach),
      hot: rgbaOf(ORB_PALETTE.hot),
    }),
    [],
  );

  // Same field parameters as the rear pass. Kept in one place per pass because
  // SkSL uniforms cannot be shared across two runtime effects.
  const uniforms = useDerivedValue(
    () => ({
      center: [centerX, centerY],
      radius,
      iTime: phaseSV.value * WEB_THREADS_TUNING.timeScale,
      uThreadCount: WEB_THREADS_TUNING.threadCount,
      uFrequency: WEB_THREADS_TUNING.frequency,
      uSpread: WEB_THREADS_TUNING.spread,
      uTaper: WEB_THREADS_TUNING.taper,
      uGlow: WEB_THREADS_TUNING.glow,
      uFalloff: WEB_THREADS_TUNING.falloff,
      uThickness: WEB_THREADS_TUNING.thickness,
      uIntensity:
        (appearance === "dark" ? 0.7 : 0.42) *
        params.fieldAlpha.value *
        ORB_APPEARANCE[appearance].fieldAlphaScale *
        (1 + energySV.value * 0.4),
      uColor1: colors.copper,
      uColor2: colors.peach,
      uColor3: colors.hot,
    }),
    [appearance, centerX, centerY, colors, energySV, params.fieldAlpha, phaseSV, radius],
  );

  if (effect === null) return null;

  return (
    <Circle cx={centerX} cy={centerY} r={radius * 1.05}>
      <Shader source={effect} uniforms={uniforms} />
    </Circle>
  );
}
