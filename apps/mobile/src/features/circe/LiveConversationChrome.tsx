import { Pressable, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import type { CirceLiveVoiceStatus } from "@circe/client-runtime/circe/liveVoiceController";

const INK = "#F6F2EF";
const MUTED = "#B9AFA6";
const HAIRLINE = "rgba(246, 242, 239, 0.16)";

/**
 * The live conversation layer.
 *
 * Separate from the listening chrome because a live conversation is not a push
 * to talk: there is no Done, the microphone stays open, and the model may be
 * speaking while the user listens. The only control is ending the session.
 */
export function LiveConversationChrome({
  progress,
  status,
  caption,
  onEnd,
}: {
  readonly progress: SharedValue<number>;
  readonly status: CirceLiveVoiceStatus;
  readonly caption: string | null;
  readonly onEnd: () => void;
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

  const title = LIVE_TITLES[status];

  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
    >
      <Animated.View style={[{ alignItems: "center", gap: 8, paddingHorizontal: 32 }, titleStyle]}>
        <Text className="font-circe-serif text-center" style={{ color: INK, fontSize: 32 }}>
          {title}
        </Text>
        <Text className="text-center text-base" style={{ color: MUTED }} numberOfLines={3}>
          {caption ?? LIVE_SUBTITLES[status]}
        </Text>
      </Animated.View>

      <View style={{ flex: 1 }} />

      <Animated.View style={[{ paddingHorizontal: 32 }, controlsStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End live conversation"
          onPress={onEnd}
          className="min-h-12 flex-row items-center justify-center gap-2 rounded-full border active:opacity-70"
          style={{ borderColor: HAIRLINE }}
        >
          <SymbolView name="xmark" size={16} tintColor={MUTED} type="monochrome" />
          <Text className="text-sm font-t3-bold" style={{ color: INK }}>
            End conversation
          </Text>
        </Pressable>
      </Animated.View>

      <View style={{ paddingTop: 14 }}>
        <Text className="text-center" style={{ color: MUTED, fontSize: 11, opacity: 0.8 }}>
          Speak naturally · Interrupt any time
        </Text>
      </View>
    </View>
  );
}

const LIVE_TITLES: Record<CirceLiveVoiceStatus, string> = {
  idle: "Live",
  requesting: "Connecting…",
  connecting: "Connecting…",
  live: "Live",
  closing: "Ending…",
  failed: "Something held me back.",
};

const LIVE_SUBTITLES: Record<CirceLiveVoiceStatus, string> = {
  idle: "Start a live conversation to talk with Circe.",
  requesting: "Opening the microphone.",
  connecting: "Setting up the conversation.",
  live: "I'm listening. Talk to me.",
  closing: "Closing the conversation.",
  failed: "The conversation stopped.",
};
