import { useMemo } from "react";
import { Circle, Shader, Skia } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import { ORB_APPEARANCE, ORB_PALETTE, rgbaOf, type OrbAppearance } from "./orbTokens";
import { WEB_THREADS_REFRACTION_SKSL, WEB_THREADS_TUNING } from "./shaders/webThreads";

/**
 * The threads seen through the lens.
 *
 * Drawn over the dark base and interior volume, under the shell, so the threads
 * that pass behind the orb are visibly bent into the glass instead of stopping
 * at its silhouette. It samples the same field as `OrbWebThreadsField` and
 * `OrbThreadsRim`, just at compressed coordinates, so it is a magnified view of
 * the threads already there rather than a third effect.
 *
 * Kept dim on purpose: the lens stays dark, and the rim caustic is what carries
 * the bright light.
 */
export function OrbThreadsRefraction({
  centerX,
  centerY,
  radius,
  phaseSV,
  energySV,
  interiorThreads,
  appearance,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly phaseSV: SharedValue<number>;
  readonly energySV: SharedValue<number>;
  /** 0 hides the interior threads entirely; the idle lens must stay clean. */
  readonly interiorThreads: SharedValue<number>;
  readonly appearance: OrbAppearance;
}) {
  const effect = useMemo(() => {
    try {
      return Skia.RuntimeEffect.Make(WEB_THREADS_REFRACTION_SKSL);
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
      // Gated by `interiorThreads`, not field alpha: the field behind the orb
      // belongs in idle, threads floating inside a still lens do not.
      uIntensity:
        (appearance === "dark" ? 0.5 : 0.32) *
        interiorThreads.value *
        ORB_APPEARANCE[appearance].fieldAlphaScale,
      // The glass magnifies: sampling at compressed coordinates makes the
      // threads inside larger than the ones passing behind the orb.
      uMagnify: 0.74,
      uEnergy: energySV.value,
      uColor1: colors.copper,
      uColor2: colors.peach,
      uColor3: colors.hot,
    }),
    [appearance, centerX, centerY, colors, energySV, interiorThreads, phaseSV, radius],
  );

  if (effect === null) return null;

  return (
    <Circle cx={centerX} cy={centerY} r={radius}>
      <Shader source={effect} uniforms={uniforms} />
    </Circle>
  );
}
