import { useEffect } from "react";
import { Pressable, View, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Canvas, Group, useClock } from "@shopify/react-native-skia";

import { OrbBase } from "./OrbBase";
import { OrbGlow } from "./OrbGlow";
import { OrbParticles } from "./OrbParticles";
import { OrbShell } from "./OrbShell";
import { OrbVoiceMeter } from "./OrbVoiceMeter";
import { OrbVolume } from "./OrbVolume";
import { OrbRibbonField } from "./RibbonField";
import { OrbThreadsRefraction } from "./OrbThreadsRefraction";
import { OrbThreadsRim } from "./OrbThreadsRim";
import { OrbWebThreadsField } from "./WebThreadsField";
import { ORB_APPEARANCE, ORB_MOTION, type OrbAppearance } from "./orbTokens";

import { useOrbTransition } from "./orbTransition";
import type { CirceOrbProps } from "./types";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The Circe orb.
 *
 * A dark lens, not a lit solid sphere: a body that absorbs light, a lit hull,
 * a broad atmosphere, and a ribbon of luminous fibers passing behind it.
 *
 * Layer order carries the whole illusion and is the single most important
 * decision in this file:
 *
 *   1. atmospheric bloom
 *   2. fiber ribbon        (behind the object, occluded by it)
 *   3. sphere group
 *        a. dark absorptive base
 *        b. interior volume   (the lit depth behind the glass)
 *        c. transparent hull  (shell, rim lip, speculars)
 *   4. grain               (around the object, never over the middle)
 *
 * Nothing is drawn over the lens body. The fibers read as passing behind it and
 * the sphere's opaque base is what hides them, so the hull keeps a clean
 * silhouette instead of having strands printed across the glass.
 *
 * The object barely moves; the ribbon and the light carry the animation. The
 * ribbon's travel accumulates per frame from a rate that eases, so changing
 * state changes its speed without jumping its position, and a 120 Hz device
 * still drifts at the same speed as a 60 Hz one. Microphone energy reaches the
 * renderer as a shared value and React never re-renders per frame.
 */
export function CirceOrb({
  state,
  size = 180,
  level = 0,
  interactive = false,
  reducedMotion = false,
  appearance = "light",
  showField = true,
  fieldRenderer = "threads",
  fieldReveal,
  width,
  onPress,
  accessibilityLabel,
  voiceMeter = false,
}: CirceOrbProps & {
  /**
   * Draw the live microphone meter in the middle of the lens. Callers that show
   * the orb as a control turn this on; decorative placements leave it off.
   */
  readonly voiceMeter?: boolean;
  readonly appearance?: OrbAppearance;
  readonly showField?: boolean;
  readonly width?: number;
}) {
  // Every parameter eases toward the state's target, so entering listening is a
  // transition rather than ten simultaneous cuts.
  const params = useOrbTransition(state, reducedMotion);
  const clock = useClock();
  const window = useWindowDimensions();

  const radius = size / 2;
  const fieldWidth = width ?? window.width;

  // Compact scene bounds. The fiber field overscans horizontally through
  // `fieldWidth`; it must not also inflate the canvas vertically, which would
  // push the surrounding layout apart and leave dead space around the orb.
  const verticalPadding = Math.max(34, size * 0.26);
  const canvasWidth = showField ? fieldWidth : size * 2;
  const canvasHeight = size + verticalPadding * 2;
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;

  const levelMirror = useSharedValue(typeof level === "number" ? level : 0);
  useEffect(() => {
    if (typeof level === "number") levelMirror.value = level;
  }, [level, levelMirror]);
  // `energy` is the single value every responsive part reads from.
  const energySV = typeof level === "object" ? level : levelMirror;

  // Reveal of the external field. A plain number becomes a mirror so the
  // planes always read from one shared value.
  const revealFallback = useSharedValue(typeof fieldReveal === "number" ? fieldReveal : 1);
  useEffect(() => {
    if (typeof fieldReveal === "number") revealFallback.value = fieldReveal;
  }, [fieldReveal, revealFallback]);
  const revealSV = typeof fieldReveal === "object" ? fieldReveal : revealFallback;

  const breathSV = useSharedValue(1);
  const pulseSV = useSharedValue(0);
  const pressedScale = useSharedValue(1);

  useEffect(() => {
    // The success pulse is decoration, so reduced motion drops it entirely
    // rather than shortening it.
    if (state !== "success" || reducedMotion) return;
    pulseSV.value = withTiming(1, { duration: 360 }, () => {
      pulseSV.value = withTiming(0, { duration: 760 });
    });
  }, [pulseSV, reducedMotion, state]);

  // Travel of the fiber ribbon, accumulated in radians and wrapped. The rate
  // comes from the eased `fieldCycleSeconds` and `motionScale`, so a state
  // change alters the speed without moving the ribbon: deriving the position
  // straight from the clock would divide by an animating period and snap the
  // phase sideways mid-transition. Accumulating by elapsed time also keeps the
  // drift identical on a 60 Hz and a 120 Hz display.
  const flowPhase = useSharedValue(0);

  useFrameCallback((frame) => {
    const t = clock.value / 1000;
    const motion = params.motionScale.value;
    const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;

    // The sphere is heavy: it only breathes. `motionScale` is what reduced
    // motion zeroes, so stillness has to reach the breath as well as the ribbon
    // or the object keeps moving on a device that asked it not to. With no
    // motion the scale is a constant, so settle it once instead of dirtying
    // the whole sphere subtree every frame.
    if (motion <= 0) {
      if (breathSV.value !== 1) breathSV.value = 1;
    } else {
      const breath =
        Math.sin((2 * Math.PI * t) / (ORB_MOTION.breathPeriodMs / 1000)) * 0.6 +
        Math.sin((2 * Math.PI * t) / (ORB_MOTION.breathSecondaryMs / 1000) + 1.7) * 0.4;
      breathSV.value = 1 + breath * ORB_MOTION.breathAmplitude * motion;
    }

    const cycleSeconds = params.fieldCycleSeconds.value;
    if (motion > 0 && Number.isFinite(cycleSeconds) && cycleSeconds > 0) {
      const next = flowPhase.value + dt * ((2 * Math.PI) / cycleSeconds) * motion;
      flowPhase.value = next % (2 * Math.PI);
    }
  });

  /** Bounded ribbon travel, -1..1. Geometry cannot be animated on this build
   * (see RibbonField), so the field moves by transforming a static path. */
  const flowSV = useDerivedValue(() => Math.sin(flowPhase.value), [flowPhase]);

  const sphereTransform = useDerivedValue(
    () => [
      {
        scale:
          breathSV.value +
          pulseSV.value * 0.018 +
          energySV.value * 0.022 * params.energyResponse.value,
      },
    ],
    [breathSV, energySV, params.energyResponse, pulseSV],
  );

  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressedScale.value }],
  }));

  // Appearance stays a pure multiplier on the eased parameters, so light and
  // dark keep sharing geometry while each state still transitions smoothly.
  const shellIntensity = useDerivedValue(
    () => params.rimIntensity.value * ORB_APPEARANCE[appearance].shellScale,
    [appearance, params.rimIntensity],
  );
  const coreWarmth = useDerivedValue(
    () => params.coreWarmth.value * ORB_APPEARANCE[appearance].coreWarmthScale,
    [appearance, params.coreWarmth],
  );

  const body = (
    <View
      style={{
        width: canvasWidth,
        height: canvasHeight,
        alignItems: "center",
        justifyContent: "center",
      }}
      accessibilityRole={interactive ? "button" : undefined}
    >
      <Canvas style={{ width: canvasWidth, height: canvasHeight }}>
        {/* 1. Atmosphere. */}
        <OrbGlow
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          bloomIntensity={params.bloomIntensity}
          energySV={energySV}
          appearance={appearance}
          reducedMotion={reducedMotion}
        />

        {/* 2. Fibers, entirely behind the lens. */}
        {showField ? (
          fieldRenderer === "threads" ? (
            <OrbWebThreadsField
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              centerX={centerX}
              centerY={centerY}
              radius={radius}
              phaseSV={flowPhase}
              energySV={energySV}
              revealSV={revealSV}
              params={params}
              appearance={appearance}
            />
          ) : (
            <OrbRibbonField
              width={fieldWidth}
              centerX={centerX}
              centerY={centerY}
              radius={radius}
              flowSV={flowSV}
              energySV={energySV}
              revealSV={revealSV}
              params={params}
              appearance={appearance}
            />
          )
        ) : null}

        {/* 3. The lens: dark base, interior volume, then the lit hull. */}
        <Group origin={{ x: centerX, y: centerY }} transform={sphereTransform}>
          <OrbBase
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            energySV={energySV}
            coreWarmth={coreWarmth}
          />

          <OrbVolume
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            energySV={energySV}
            volumeIntensity={params.volumeIntensity}
          />

          {/* The refracted threads: the same field bent into the glass, so the
              threads visibly enter the lens instead of stopping behind it. */}
          {fieldRenderer === "threads" ? (
            <OrbThreadsRefraction
              centerX={centerX}
              centerY={centerY}
              radius={radius}
              phaseSV={flowPhase}
              energySV={energySV}
              interiorThreads={params.interiorThreads}
              appearance={appearance}
            />
          ) : null}

          <OrbShell
            centerX={centerX}
            centerY={centerY}
            radius={radius}
            energySV={energySV}
            shellIntensity={shellIntensity}
            reducedMotion={reducedMotion}
          />

          {/* The thread caustic rides on the hull, so the glass is lit by the
              threads passing through it instead of sitting in front of them. */}
          {fieldRenderer === "threads" ? (
            <OrbThreadsRim
              centerX={centerX}
              centerY={centerY}
              radius={radius}
              phaseSV={flowPhase}
              energySV={energySV}
              params={params}
              appearance={appearance}
            />
          ) : null}
        </Group>

        {/* 4. Grain. Faded by `particleAmount`, which is zero in idle, so the
            hero frame stays clean without the dots popping in on a state
            change. */}
        <OrbParticles
          centerX={centerX}
          centerY={centerY}
          radius={radius}
          amount={params.particleAmount}
          reducedMotion={reducedMotion}
        />
      </Canvas>
      {voiceMeter ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <OrbVoiceMeter level={energySV} reducedMotion={reducedMotion} />
        </View>
      ) : null}
    </View>
  );

  if (!interactive) return body;
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? "Circe voice"}
      onPress={onPress}
      onPressIn={() => {
        pressedScale.value = withTiming(0.97, { duration: 120 });
      }}
      onPressOut={() => {
        pressedScale.value = withTiming(1, { duration: 180 });
      }}
      style={[
        { alignItems: "center", justifyContent: "center", minWidth: 44, minHeight: 44 },
        pressStyle,
      ]}
    >
      {body}
    </AnimatedPressable>
  );
}
