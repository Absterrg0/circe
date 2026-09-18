import { useMemo } from "react";
import { Group, Path, Skia, type SkPath } from "@shopify/react-native-skia";
import { useDerivedValue, type SharedValue } from "react-native-reanimated";

import {
  ORB_APPEARANCE,
  ORB_PALETTE,
  ORB_MOTION,
  alphaColor,
  hash01,
  type OrbAppearance,
} from "./orbTokens";
import type { OrbAnimatedParams } from "./orbTransition";

/**
 * The Circe ribbon.
 *
 * An earlier version gave every strand its own frequency, amplitude, phase,
 * offset and speed. That is a recipe for spaghetti no matter how many strands
 * are removed, and it is why the field read as procedural noise.
 *
 * There is now exactly ONE flowing centerline. Every ribbon filament is a small
 * offset from it, so the group reads as a single piece of silk. A few very faint
 * atmosphere fibers keep their own trajectories, but they are deliberately
 * barely visible.
 *
 * Ribbon filaments: 8, alpha 0.14-0.34, two of them highlighted at 0.38-0.55.
 * Atmosphere fibers: 5, alpha 0.04-0.10.
 */

interface Filament {
  readonly index: number;
  /** Position across the ribbon, -1..1. */
  readonly offset: number;
  readonly alpha: number;
  readonly width: number;
  readonly color: string;
  readonly jitterPhase: number;
  readonly jitterAmount: number;
  /** Independent trajectory, used only by the faint atmosphere fibers. */
  readonly independent: boolean;
  readonly frequency: number;
  readonly phase: number;
  readonly amplitude: number;
  readonly yOffset: number;
}

const OVERSCAN = 140;
const SEGMENTS = 64;

/**
 * How far the ribbon sways, in points. The field drifts by translating its
 * geometry because paths cannot be animated on this Skia build: handing a
 * shared value to a `path` prop takes the whole canvas down, whether the path
 * was built on the JS thread or inside the derived value. That is also why
 * Skia's own `usePathInterpolation` left every fiber invisible — its
 * interpolated path is published through a private UI-thread notification the
 * renderer never heard.
 *
 * Travel is bounded rather than continuous. The field's amplitude envelope is
 * centred on the sphere, and translating the geometry carries that envelope
 * with it, so a full wavelength of travel would sweep the ribbon's shape across
 * the screen instead of flowing it through the orb. A fraction of a wavelength
 * reads as the silk sliding past and leaves the shape where it was designed.
 */
const FLOW_TRAVEL = 52;

/** A translate-only transform array, the shape Skia's Group accepts. */
type TranslateTransform = { translateX: number }[];

/** Primary wavelength of the shared centerline, in points. */
const CENTERLINE_K = (Math.PI * 2) / ORB_MOTION.strandWavelengthPx;

const RIBBON_COUNT = 8;
const ATMOSPHERE_COUNT = 5;

function buildFilaments(radius: number): Filament[] {
  const filaments: Filament[] = [];

  // The ribbon. Offsets are spread across the bundle width and alpha rises
  // toward the interior so the fabric has a bright core and soft edges.
  for (let index = 0; index < RIBBON_COUNT; index += 1) {
    const offset = (index / (RIBBON_COUNT - 1)) * 2 - 1;
    const centrality = 1 - Math.abs(offset);
    const hero = index === 2 || index === 5;
    filaments.push({
      index,
      offset,
      alpha: hero ? 0.38 + hash01(index, 21) * 0.17 : 0.14 + centrality * 0.2,
      width: hero ? 1.15 + hash01(index, 22) * 0.3 : 0.7 + hash01(index, 22) * 0.25,
      color: hero ? ORB_PALETTE.peach : ORB_PALETTE.copper,
      jitterPhase: hash01(index, 23) * Math.PI * 2,
      jitterAmount: 0.6 + hash01(index, 24) * 1.2,
      independent: false,
      frequency: CENTERLINE_K,
      phase: 0,
      amplitude: 1,
      yOffset: 0,
    });
  }

  // Atmosphere fibers. Faint, independent, and never the focus.
  for (let index = 0; index < ATMOSPHERE_COUNT; index += 1) {
    filaments.push({
      index: RIBBON_COUNT + index,
      offset: 0,
      alpha: 0.04 + hash01(index, 31) * 0.06,
      width: 0.6 + hash01(index, 32) * 0.25,
      color: ORB_PALETTE.copper,
      jitterPhase: 0,
      jitterAmount: 0,
      independent: true,
      frequency: CENTERLINE_K * (0.55 + hash01(index, 33) * 0.5),
      phase: hash01(index, 34) * Math.PI * 2,
      amplitude: (10 + hash01(index, 35) * 12) * 0.5,
      yOffset: (hash01(index, 36) - 0.5) * 2 * radius * 0.95,
    });
  }

  return filaments;
}

/**
 * The shared centerline: one broad S-curve that every ribbon filament follows.
 *
 * The shape is built once, at zero phase, and the field's travel is a
 * translation of that geometry rather than a re-derivation of it. There is no
 * phase argument and no amplitude argument for the same reason: both were part
 * of a path-morphing approach this renderer cannot support, and a knob nothing
 * can turn is worse than no knob.
 */
function centerlineY(x: number, centerX: number, centerY: number, radius: number): number {
  const envelope = 0.28 + 0.72 * Math.exp(-Math.pow((x - centerX) / (radius * 1.35), 2));
  return (
    centerY + (Math.sin(CENTERLINE_K * x) * 17 + Math.sin(CENTERLINE_K * 0.5 * x) * 8) * envelope
  );
}

/** How wide the bundle is at a given x. Widens near the sphere, narrows out. */
function bundleEnvelope(x: number, centerX: number, radius: number): number {
  return 0.3 + 0.7 * Math.exp(-Math.pow((x - centerX) / (radius * 1.1), 2));
}

/**
 * One strand, as a polyline. The bundle is widest where it passes the sphere,
 * which is what makes the ribbon read as a single piece of silk gathered at the
 * centre rather than as parallel lines.
 */
function buildFilamentPath(
  filament: Filament,
  width: number,
  centerX: number,
  centerY: number,
  radius: number,
): SkPath {
  const path = Skia.PathBuilder.Make();
  const span = width + OVERSCAN * 2;
  const bundleHalfWidth = radius * 0.3;

  for (let s = 0; s <= SEGMENTS; s += 1) {
    const t = s / SEGMENTS;
    const x = t * span - OVERSCAN;

    let outY: number;

    if (filament.independent) {
      outY =
        centerY +
        filament.yOffset +
        Math.sin(filament.frequency * x + filament.phase) * filament.amplitude;
    } else {
      const base = centerlineY(x, centerX, centerY, radius);
      const jitter = Math.sin(x * 0.021 + filament.jitterPhase) * filament.jitterAmount;
      outY = base + filament.offset * bundleHalfWidth * bundleEnvelope(x, centerX, radius) + jitter;
    }

    if (s === 0) path.moveTo(x, outY);
    else path.lineTo(x, outY);
  }
  return path.detach();
}

function Filament({
  filament,
  width,
  centerX,
  centerY,
  radius,
  flowTransform,
  energySV,
  revealSV,
  params,
  appearance,
}: {
  readonly filament: Filament;
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly flowTransform: SharedValue<TranslateTransform>;
  readonly energySV: SharedValue<number>;
  readonly revealSV: SharedValue<number>;
  readonly params: OrbAnimatedParams;
  readonly appearance: OrbAppearance;
}) {
  // Built once at unit amplitude. The state's field amplitude is a scale on the
  // group below rather than baked geometry, so a state change eases instead of
  // rebuilding every path on the JS thread and popping the ribbon's shape.
  const path = useMemo(
    () => buildFilamentPath(filament, width, centerX, centerY, radius),
    [filament, width, centerX, centerY, radius],
  );

  // The state's field amplitude sets the wave height, and the voice opens the
  // ribbon up from there: because the scale is applied to the whole strand and
  // not only to the wave, energy lifts the bundle's spread as well as its
  // height. That spread is the ruffle — the silk loosening as someone speaks
  // and settling back when they stop.
  const stretch = useDerivedValue(
    () => [
      {
        scaleY:
          params.fieldAmplitude.value * (1 + energySV.value * 0.85 * params.energyResponse.value),
      },
    ],
    [energySV, params.energyResponse, params.fieldAmplitude],
  );
  // The strand carries the reveal instead of the field using a `Group opacity`.
  // Group opacity makes Skia allocate a full-canvas layer, which some Android
  // GPUs draw as a soft-edged square; applying the reveal in both places also
  // made the strands quadratic through the transition and hollow at the
  // halfway point. It lives here once.
  const liveAlpha = useDerivedValue(
    () =>
      filament.alpha *
      params.fieldAlpha.value *
      ORB_APPEARANCE[appearance].fieldAlphaScale *
      revealSV.value *
      (1 + energySV.value * 0.8 * params.energyResponse.value),
    [appearance, energySV, filament.alpha, params.energyResponse, params.fieldAlpha, revealSV],
  );

  const restY = centerY + filament.yOffset;
  // One pass per filament. An earlier glow-plus-core double pass doubled the
  // fill for a halo the eye could not separate from the stroke, so the core
  // carries a little extra width instead.
  const coreColor = useDerivedValue(
    () => alphaColor(filament.color, liveAlpha.value),
    [filament.color, liveAlpha],
  );

  return (
    <Group origin={{ x: centerX, y: restY }} transform={stretch}>
      <Group transform={flowTransform}>
        <Path
          path={path}
          style="stroke"
          strokeWidth={filament.width * 1.15}
          strokeCap="round"
          color={coreColor}
        />
      </Group>
    </Group>
  );
}

/**
 * The ribbon field, drawn once and entirely behind the lens.
 *
 * There is one pass, not three. An earlier version also drew the ribbon
 * refracted inside the glass and again across the front, which read as strands
 * printed on the lens and broke the silhouette. The sphere's opaque base is now
 * the only thing that hides the ribbon, so it passes behind the object the way
 * a physical ribbon behind a lens would.
 */
export function OrbRibbonField({
  width,
  centerX,
  centerY,
  radius,
  flowSV,
  energySV,
  revealSV,
  params,
  appearance,
}: {
  readonly width: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly radius: number;
  readonly flowSV: SharedValue<number>;
  readonly energySV: SharedValue<number>;
  readonly revealSV: SharedValue<number>;
  readonly params: OrbAnimatedParams;
  readonly appearance: OrbAppearance;
}) {
  const filaments = useMemo(() => buildFilaments(radius), [radius]);

  // The reveal grows the field outward from the sphere: strands fade in while
  // the whole ribbon scales up from the orb centre, so the wave reads as
  // originating from Circe rather than switching on across the screen. The
  // strands themselves carry no reveal term, so this is the only place the
  // transition is applied.
  // The whole ribbon travels together, so this is composed once for the field
  // rather than once per strand. Every strand's travel is now identical, and
  // twenty-eight identical derivations invalidate on every frame for nothing.
  const flowTransform = useDerivedValue(
    () => [{ translateX: flowSV.value * FLOW_TRAVEL }],
    [flowSV],
  );

  const revealTransform = useDerivedValue(
    () => [{ scale: 0.55 + 0.45 * revealSV.value }],
    [revealSV],
  );

  const strands = filaments.map((filament) => (
    <Filament
      key={filament.index}
      filament={filament}
      width={width}
      centerX={centerX}
      centerY={centerY}
      radius={radius}
      flowTransform={flowTransform}
      energySV={energySV}
      revealSV={revealSV}
      params={params}
      appearance={appearance}
    />
  ));

  return (
    <Group origin={{ x: centerX, y: centerY }} transform={revealTransform}>
      {strands}
    </Group>
  );
}
