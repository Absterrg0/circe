import { useMemo } from "react";
import { Group, Rect, Shader, Skia } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_APPEARANCE, ORB_PALETTE, rgbaOf, type OrbAppearance } from "./orbTokens";
import type { OrbAnimatedParams } from "./orbTransition";
import { WEB_THREADS_FIELD_SKSL, WEB_THREADS_TUNING } from "./shaders/webThreads";

/**
 * The Web Threads fiber field: one GPU pass of glowing sine threads woven
 * through the orb's convergence point.
 *
 * This is the prototype counterpart to `OrbRibbonField` and shares its
 * contract: drawn behind the whole sphere, so the opaque base is the only
 * thing that hides a thread, and revealed by a group transform rather than by
 * rebuilding geometry. Unlike the ribbon it replaces no paths at all — the
 * threads live entirely in the fragment shader, so travel is a uniform update
 * on the UI thread and the documented "paths cannot be animated" trap does not
 * apply here.
 *
 * `phaseSV` is the orb's accumulated flow phase in radians, not a 0..1 value.
 * The shader consumes it as time; wrapping at 2π is seamless because every
 * term is periodic over that interval.
 */
export function OrbWebThreadsField({
  canvasWidth,
  canvasHeight,
  centerX,
  centerY,
  radius,
  phaseSV,
  energySV,
  revealSV,
  params,
  appearance,
}: {
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly phaseSV: SharedValue<number>;
  readonly energySV: SharedValue<number>;
  readonly revealSV: SharedValue<number>;
  readonly params: OrbAnimatedParams;
  readonly appearance: OrbAppearance;
}) {
  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(WEB_THREADS_FIELD_SKSL);
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
      uBrightness: WEB_THREADS_TUNING.brightness,
      uOpacity: params.fieldAlpha.value * ORB_APPEARANCE[appearance].fieldAlphaScale,
      uEnergy: energySV.value,
      // Threads gather at the hull and are gone before the canvas edge, so the
      // field belongs to the orb instead of reading as a wallpaper.
      uFadeNear: 0.3,
      uFadeFar: 3.2,
      uColor1: colors.copper,
      uColor2: colors.peach,
      uColor3: colors.hot,
    }),
    [appearance, centerX, centerY, colors, energySV, params.fieldAlpha, phaseSV, radius],
  );

  const revealOpacity = useDerivedValue(() => revealSV.value, [revealSV]);
  const revealTransform = useDerivedValue(
    () => [{ scale: 0.55 + 0.45 * revealSV.value }],
    [revealSV],
  );

  if (effect === null) return null;

  return (
    <Group origin={{ x: centerX, y: centerY }} transform={revealTransform} opacity={revealOpacity}>
      <Rect x={0} y={0} width={canvasWidth} height={canvasHeight}>
        <Shader source={effect} uniforms={uniforms} />
      </Rect>
    </Group>
  );
}
