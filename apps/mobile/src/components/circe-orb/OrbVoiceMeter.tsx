import { useEffect, type ReactNode } from "react";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

/**
 * The voice meter in the middle of the lens.
 *
 * It used to be five fixed bars drawn by the caller. Static bars in the middle
 * of an object that is otherwise alive read as a sticker, and they said nothing
 * about whether Circe could actually hear you — which is the one thing someone
 * speaking wants to know. The bars are now the level signal: they breathe
 * gently while the microphone is open and answer the voice directly.
 *
 * The bars are Reanimated transforms on the UI thread, so a live meter costs no
 * React renders per sample.
 */

const BAR_COUNT = 5;
/** Per-bar response and idle weight, left to right. Taller toward the middle. */
const BARS = [
  { gain: 0.62, idle: 0.5 },
  { gain: 1.0, idle: 0.9 },
  { gain: 0.78, idle: 0.62 },
  { gain: 1.1, idle: 1 },
  { gain: 0.58, idle: 0.46 },
] as const;

const BAR_WIDTH = 3;
const BAR_HEIGHT = 26;
const IDLE_PERIOD_MS = 2600;
/** Nothing collapses to a point: even silence keeps a readable meter. */
const MIN_SCALE = 0.14;
const MAX_SCALE = 1.45;

const METER_COLOR = "#FFF6EF";

function MeterBar({
  level,
  idle,
  index,
  gain,
  idleWeight,
}: {
  readonly level: SharedValue<number>;
  readonly idle: SharedValue<number>;
  readonly index: number;
  readonly gain: number;
  readonly idleWeight: number;
}) {
  const style = useAnimatedStyle(() => {
    // Each bar breathes on its own offset so the row never pulses in unison.
    const breathing = 0.2 + 0.12 * Math.sin((idle.value + index * 0.17) * Math.PI * 2);
    const scaleY = breathing * idleWeight + level.value * gain;
    return {
      transform: [{ scaleY: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scaleY)) }],
    };
  }, [gain, idle, idleWeight, index, level]);

  return (
    <Animated.View
      style={[
        {
          width: BAR_WIDTH,
          height: BAR_HEIGHT,
          borderRadius: BAR_WIDTH / 2,
          backgroundColor: METER_COLOR,
          opacity: 0.92,
        },
        style,
      ]}
    />
  );
}

export function OrbVoiceMeter({
  level,
  reducedMotion,
}: {
  readonly level: SharedValue<number>;
  readonly reducedMotion: boolean;
}) {
  const idle = useSharedValue(0);

  useEffect(() => {
    // Reduced motion stills the autonomous breathing and leaves the response to
    // the voice, which is the user's own input rather than motion imposed on
    // them.
    if (reducedMotion) {
      idle.value = 0;
      return;
    }
    idle.value = withRepeat(
      withTiming(1, { duration: IDLE_PERIOD_MS, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [idle, reducedMotion]);

  const row: ReactNode[] = [];
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const bar = BARS[index];
    if (bar === undefined) continue;
    row.push(
      <MeterBar
        key={index}
        level={level}
        idle={idle}
        index={index}
        gain={bar.gain}
        idleWeight={bar.idle}
      />,
    );
  }

  return (
    <Animated.View
      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
      accessibilityRole="image"
      accessibilityLabel="Voice level"
    >
      {row}
    </Animated.View>
  );
}
