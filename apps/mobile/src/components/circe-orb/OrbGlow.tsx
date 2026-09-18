import { useMemo } from "react";
import { Circle, Group, RadialGradient, useClock, vec } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import {
  ORB_APPEARANCE,
  ORB_MOTION,
  ORB_PALETTE,
  alphaColor,
  type OrbAppearance,
} from "./orbTokens";

/**
 * Atmospheric bloom, drawn before everything else.
 *
 * Two fields, because one broad gradient cannot be simultaneously broad and
 * present:
 *
 *   A. ~1.55R  broad peach atmosphere, the light spilling onto the page
 *   B. ~1.22R  warm bloom hugging the object, peaking into a shell aura
 *
 * Neither is a ring: ring-shaped peaks read as concentric outlines.
 *
 * The field is driven by microphone energy through `energySV`. An earlier
 * version documented bloom as audio-responsive while never passing the level
 * in, so the claim was false; the alpha now genuinely rises with energy.
 *
 * Alpha is baked into the gradient stops on the UI thread. Neither `opacity`
 * nor `BlurMask` is used: on some Android GPUs both make Skia allocate a layer,
 * and layers render as soft-edged squares around a glow.
 */
export function OrbGlow({
  centerX,
  centerY,
  radius,
  bloomIntensity,
  energySV,
  appearance,
  reducedMotion,
}: {
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly bloomIntensity: SharedValue<number>;
  readonly energySV: SharedValue<number>;
  readonly appearance: OrbAppearance;
  readonly reducedMotion: boolean;
}) {
  const clock = useClock();
  const bloomScale = ORB_APPEARANCE[appearance].bloomScale;

  // The broad atmosphere is centred slightly above the object, matching the
  // reference where the page is lit from the upper part of the globe.
  const atmosphereCenter = useMemo(
    () => vec(centerX, centerY - radius * 0.08),
    [centerX, centerY, radius],
  );

  // Voice reaches the glow strongly. The bloom is the light the orb casts on
  // the page, so it is the first thing that should answer someone speaking;
  // before this the energy term moved the bloom by a few percent and the object
  // read as inert while the microphone was live.
  const atmosphereColors = useDerivedValue(() => {
    const gain = bloomIntensity.value * bloomScale * (1 + energySV.value * 0.8);
    return [
      alphaColor(ORB_PALETTE.peach, gain * 0.04),
      alphaColor(ORB_PALETTE.peach, gain * 0.1),
      alphaColor(ORB_PALETTE.peach, 0),
    ];
  }, [bloomIntensity, bloomScale, energySV]);

  // One warm hug instead of two overlapping ones: the medium bloom and the
  // localized shell aura peaked within a few percent of each other, so a
  // single gradient carries the copper body out to the peach edge.
  const bloomColors = useDerivedValue(() => {
    const gain = bloomIntensity.value * bloomScale * (1 + energySV.value * 0.95);
    return [
      alphaColor(ORB_PALETTE.copper, 0),
      alphaColor(ORB_PALETTE.copper, gain * 0.17),
      alphaColor(ORB_PALETTE.peach, gain * 0.26),
      alphaColor(ORB_PALETTE.peach, 0),
    ];
  }, [bloomIntensity, bloomScale, energySV]);

  const swell = useDerivedValue(() => {
    if (reducedMotion) return 0.5;
    const t = clock.value / 1000;
    return 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / (ORB_MOTION.bloomPeriodMs / 1000));
  }, [clock, reducedMotion]);

  const atmosphereR = useDerivedValue(() => radius * (1.55 + swell.value * 0.06), [radius, swell]);
  const bloomR = useDerivedValue(() => radius * (1.22 + swell.value * 0.04), [radius, swell]);

  return (
    <Group>
      {/* A. Broad atmosphere. This is what lights the page around Circe. */}
      <Circle cx={centerX} cy={centerY} r={atmosphereR}>
        <RadialGradient
          c={atmosphereCenter}
          r={atmosphereR}
          colors={atmosphereColors}
          positions={[0.3, 0.62, 1]}
        />
      </Circle>

      {/* B. Warm bloom with a shell-aura peak. */}
      <Circle cx={centerX} cy={centerY} r={bloomR}>
        <RadialGradient
          c={vec(centerX, centerY)}
          r={bloomR}
          colors={bloomColors}
          positions={[0.7, 0.9, 0.96, 1]}
        />
      </Circle>
    </Group>
  );
}
