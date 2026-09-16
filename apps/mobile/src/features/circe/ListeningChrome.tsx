import { Pressable, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { CirceOrbState } from "../../components/circe-orb/types";

const INK = "#F6F2EF";
const MUTED = "#B9AFA6";
const HAIRLINE = "rgba(246, 242, 239, 0.16)";

/**
 * The listening layer of the Circe home scene. Not a destination: it is an
 * overlay around the one persistent orb, driven by the scene's visual
 * progress value. Home chrome fades out while this fades in, and the exit
 * path is the same animation in reverse rather than a back navigation.
 */
export function ListeningChrome({
  progress,
  phase,
  errorMessage,
  busyLabel,
  onTypeInstead,
  onCancel,
  onDone,
}: {
  readonly progress: SharedValue<number>;
  readonly phase: CirceOrbState;
  readonly errorMessage: string | null;
  /** While set, the title shows this instead of Listening and Done is disabled. */
  readonly busyLabel?: string | null;
  readonly onTypeInstead: () => void;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) {
  const titleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.4, 0.75], [0, 1], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(progress.value, [0.4, 0.75], [12, 0], Extrapolation.CLAMP) },
    ],
  }));
  const controlsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.6, 0.95], [0, 1], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(progress.value, [0.6, 0.95], [14, 0], Extrapolation.CLAMP) },
    ],
  }));
  const footerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.75, 1], [0, 1], Extrapolation.CLAMP),
  }));

  const title = busyLabel ?? (phase === "error" ? "Something held me back." : "Listening…");
  const subtitle =
    phase === "error" && errorMessage !== null ? errorMessage : "Speak naturally. I'm here.";

  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
    >
      <Animated.View style={[{ alignItems: "center", gap: 8, paddingHorizontal: 32 }, titleStyle]}>
        <Text className="font-circe-serif text-center" style={{ color: INK, fontSize: 32 }}>
          {title}
        </Text>
        <Text className="text-center text-base" style={{ color: MUTED }}>
          {subtitle}
        </Text>
      </Animated.View>

      <View style={{ flex: 1 }} />

      <Animated.View
        style={[{ flexDirection: "row", gap: 12, paddingHorizontal: 32 }, controlsStyle]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done speaking"
          onPress={onDone}
          disabled={busyLabel != null}
          className="min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full active:opacity-70"
          style={{
            backgroundColor: "rgba(246, 242, 239, 0.92)",
            opacity: busyLabel != null ? 0.6 : 1,
          }}
        >
          <SymbolView name="checkmark" size={16} tintColor="#171310" type="monochrome" />
          <Text className="text-sm font-t3-bold" style={{ color: "#171310" }}>
            Done
          </Text>
        </Pressable>
      </Animated.View>

      <Animated.View
        style={[
          { flexDirection: "row", gap: 12, paddingHorizontal: 32, paddingTop: 10 },
          controlsStyle,
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Type instead"
          onPress={onTypeInstead}
          className="min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full border active:opacity-70"
          style={{ borderColor: HAIRLINE }}
        >
          <SymbolView name={{ ios: "keyboard", android: "keyboard" }} size={18} tintColor={MUTED} />
          <Text className="text-sm font-t3-bold" style={{ color: INK }}>
            Type instead
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel voice"
          onPress={onCancel}
          className="min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-full border active:opacity-70"
          style={{ borderColor: HAIRLINE }}
        >
          <SymbolView name="xmark" size={16} tintColor={MUTED} type="monochrome" />
          <Text className="text-sm font-t3-bold" style={{ color: INK }}>
            Cancel
          </Text>
        </Pressable>
      </Animated.View>

      <Animated.View style={footerStyle}>
        <Text
          className="text-center"
          style={{ color: MUTED, fontSize: 11, paddingTop: 14, opacity: 0.8 }}
        >
          Think · Take action · Get results
        </Text>
      </Animated.View>
    </View>
  );
}
