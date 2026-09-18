import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@circe/contracts";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUser } from "@clerk/expo";
import { File } from "expo-file-system";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { AppText as Text } from "../../components/AppText";
import { CirceHeaderTitle } from "../../components/CirceHeaderTitle";
import { SymbolView } from "../../components/AppSymbol";
import type { AppSymbolName } from "../../components/AppSymbol";
import { CirceOrb } from "../../components/circe-orb/CirceOrb";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { CirceTabBar } from "./CirceTabBar";
import { CirceMemories } from "./CirceMemories";
import { CirceNeedsAttention } from "./CirceNeedsAttention";
import { ListeningChrome } from "./ListeningChrome";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { useWorkspaceState } from "../../state/workspace";
import { useCirceController } from "./CirceMobileProvider";
import { useSystemReducedMotion, useVoiceOrbLevel } from "./useVoiceOrbLevel";
import { transcribeCapturedVoice } from "./voiceTranscribe";
import { LiveConversationChrome } from "./LiveConversationChrome";
import { hasOnlineCirceNode, NO_DEVICES_COPY } from "./circeAvailability";
import {
  isLiveConversationActive,
  startLiveConversation,
  stopLiveConversation,
  useLiveConversation,
} from "./liveVoice";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";

/** Warm near-black the scene settles into while listening. Never navy. */
const ESPRESSO = "#171310";
const LISTENING_INK = "#F6F2EF";

const HOME_ORB_SIZE = 168;
const VOICE_ORB_SIZE = 232;
const ENTER_MS = 560;
const EXIT_MS = 480;
/**
 * Entry and exit share one curve so the scene is genuinely reversible: with a
 * symmetric ease, playing the progress value backwards retraces the same
 * frames. Cubic rather than quadratic because the orb's mass reads better with
 * a softer start and a longer settle.
 */
const SCENE_EASING = Easing.inOut(Easing.cubic);

/**
 * The scene's visual state. `enteringVoice`/`exitingVoice` are the cinematic
 * transition; `voice` is the settled listening surface. The orb's semantic
 * state (idle/listening/error/...) stays separate in `phase` and never drives
 * layout, so a mic error mid-entry cannot strand the chrome halfway.
 */
type SurfaceMode = "home" | "enteringVoice" | "voice" | "exitingVoice";

function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * The home greeting. A signed-in user is addressed by first name when Clerk
 * has one; everyone else — including anyone who chose "Continue as guest" — is
 * greeted as Guest, so the surface never implies an account that is not there.
 *
 * `useUser` requires the Clerk provider, which `CloudAuthProvider` only mounts
 * when the account service is configured, so the hook lives behind that check.
 */
function AssistantGreeting() {
  const greeting = useMemo(() => greetingForHour(new Date().getHours()), []);
  const address = hasCloudPublicConfig() ? <AccountGreetingName /> : "Guest";

  return (
    <View className="gap-1 px-1 pt-2">
      <Text className="font-circe-serif text-3xl leading-tight text-foreground">
        {greeting}, {address}
      </Text>
      <Text className="text-base text-foreground-muted">What shall we do today?</Text>
    </View>
  );
}

function AccountGreetingName() {
  const { isLoaded, isSignedIn, user } = useUser();
  if (!isLoaded || isSignedIn !== true) return "Guest";
  const name = user?.firstName?.trim();
  return name && name.length > 0 ? name : "Guest";
}

const QUICK_ACTIONS: ReadonlyArray<{ label: string; prompt: string; icon: AppSymbolName }> = [
  { label: "Summarise my work", prompt: "Summarise my work across all machines", icon: "doc.text" },
  { label: "Draft something", prompt: "Draft something for me: ", icon: "square.and.pencil" },
  { label: "Find anything", prompt: "Find ", icon: "magnifyingglass" },
  { label: "Plan my day", prompt: "Plan my day", icon: "clock" },
];

/**
 * The Circe home scene. Home and listening are one physical scene around a
 * single persistent orb: entering voice never navigates, never remounts the
 * orb, and exits by reversing the same animation. The orb renders at a stable
 * size and only its wrapper scales/translates on the UI thread.
 */
export function CirceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const controller = useCirceController();
  const catalog = controller.catalog;
  // No connected device means nothing the assistant can do; every entry point
  // gates on this rather than attempting an RPC that cannot succeed.
  const hasDevice = hasOnlineCirceNode(catalog);
  // The environment registry, not the Circe catalog, owns "still coming up".
  // On a cold start the catalog is non-null with no reachable node while a
  // saved environment reconnects, so gating on the catalog alone showed a
  // false "No devices connected" and then flipped to the full UI.
  const { state: workspace } = useWorkspaceState();
  const devicesConnecting =
    workspace.isLoadingConnections ||
    workspace.hasConnectingEnvironment ||
    (workspace.hasReadyEnvironment && !hasDevice);
  const { themeAppearance } = useAppearancePreferences();
  const reducedMotion = useSystemReducedMotion();
  const [utterance, setUtterance] = useState("");
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>("home");
  // Transient voice-finish state. `voiceBusyLabel` covers the listening title
  // while the recording transcribes; `voiceNotice` reuses the listening error
  // copy when there is nothing to submit, so a dead mic is never silence.
  const [voiceBusyLabel, setVoiceBusyLabel] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  // Which mode owns the voice surface. A live conversation and push-to-talk
  // both need the microphone, so exactly one of them may hold it.
  const [voiceOwner, setVoiceOwner] = useState<"dictation" | "live" | null>(null);
  const live = useLiveConversation();
  const composerRef = useRef<TextInput>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Purely visual 0 → 1. Everything cinematic reads from this; nothing
  // semantic does.
  const voiceProgress = useSharedValue(0);
  /**
   * How far the orb has to travel to sit in the middle of the scene once the
   * home chrome has gone.
   *
   * At home the orb sits in the scroll flow between the greeting and the
   * composer, which puts it well above the middle of the screen. With the
   * chrome hidden that left the listening surface with the orb high and a large
   * void beneath it. The travel is measured rather than guessed, because the
   * home layout above the orb is not a fixed height.
   */
  const [sceneHeight, setSceneHeight] = useState(0);
  const [orbAnchor, setOrbAnchor] = useState<{ top: number; height: number } | null>(null);
  const scrollOffset = useRef(0);
  const voiceOrbShift = useSharedValue(0);

  const onSceneLayout = useCallback((event: LayoutChangeEvent) => {
    setSceneHeight(event.nativeEvent.layout.height);
  }, []);
  const onOrbLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setOrbAnchor({ top: y, height });
  }, []);
  const onSceneScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffset.current = event.nativeEvent.contentOffset.y;
  }, []);
  // The wave grows outward from the orb as the scene settles into listening
  // and collapses back into it on cancel. Geometry untouched, only revealed.
  const fieldReveal = useDerivedValue(
    () => interpolate(voiceProgress.value, [0.12, 0.85], [0, 1], Extrapolation.CLAMP),
    [voiceProgress],
  );

  useEffect(() => {
    if (controller.catalog === null) void controller.refresh();
  }, [controller.catalog, controller.refresh]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    },
    [],
  );

  const later = useCallback((ms: number, work: () => void) => {
    timers.current.push(setTimeout(work, ms));
  }, []);
  const clearPendingTransitions = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const enterVoice = useCallback(
    (owner: "dictation" | "live") => {
      clearPendingTransitions();
      setVoiceNotice(null);
      setVoiceBusyLabel(null);
      setVoiceOwner(owner);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      // Measured here, at the moment the scroll is about to be locked, so the
      // current scroll position is still the one that applies.
      if (sceneHeight > 0 && orbAnchor !== null) {
        const homeCentre = orbAnchor.top + orbAnchor.height / 2 - scrollOffset.current;
        voiceOrbShift.value = sceneHeight / 2 - homeCentre;
      } else {
        voiceOrbShift.value = 0;
      }
      setSurfaceMode("enteringVoice");
      const duration = reducedMotion ? 0 : ENTER_MS;
      voiceProgress.value = withTiming(1, { duration, easing: SCENE_EASING });
      later(reducedMotion ? 30 : ENTER_MS + 40, () => setSurfaceMode("voice"));
    },
    [
      clearPendingTransitions,
      later,
      orbAnchor,
      reducedMotion,
      sceneHeight,
      voiceOrbShift,
      voiceProgress,
    ],
  );

  const exitVoice = useCallback(() => {
    clearPendingTransitions();
    setVoiceOwner(null);
    setSurfaceMode("exitingVoice");
    const duration = reducedMotion ? 0 : EXIT_MS;
    voiceProgress.value = withTiming(0, { duration, easing: SCENE_EASING });
    later(reducedMotion ? 30 : EXIT_MS + 40, () => setSurfaceMode("home"));
  }, [clearPendingTransitions, later, reducedMotion, voiceProgress]);

  const typeInstead = useCallback(() => {
    exitVoice();
    later(550, () => composerRef.current?.focus());
  }, [exitVoice, later]);

  const modeRef = useRef(surfaceMode);
  modeRef.current = surfaceMode;

  // A live conversation owns the microphone for as long as it runs, so the
  // dictation recorder must stay closed for that whole time.
  const voiceActive = surfaceMode !== "home";
  const dictationActive = voiceActive && voiceOwner === "dictation";
  const { level, phase, errorMessage, stopAndCaptureUri } = useVoiceOrbLevel(dictationActive);
  const orbState = dictationActive ? phase : voiceActive ? "listening" : "idle";

  // The node that mints the session. A live conversation is not bound to a
  // project — the phone runs the Director and the node only mints the speech
  // session — so any reachable node will do. An offline node is never chosen:
  // attempting the mint against one fails with a vague error instead of the
  // honest "connect a machine", which is the only actionable thing to say.
  const liveVoiceNodeId = useMemo(() => {
    const nodes = controller.catalog?.nodes ?? [];
    const isOnline = (nodeId: EnvironmentId | undefined): boolean =>
      nodeId !== undefined &&
      nodes.some((node) => node.nodeId === nodeId && node.reachability === "online");
    const projectNodeId = controller.selectedProject?.ref.nodeId;
    if (isOnline(projectNodeId)) return projectNodeId ?? null;
    if (isOnline(controller.taskDeskNodeId ?? undefined)) return controller.taskDeskNodeId;
    return nodes.find((node) => node.reachability === "online")?.nodeId ?? null;
  }, [controller.catalog, controller.selectedProject, controller.taskDeskNodeId]);

  const beginLiveConversation = useCallback(() => {
    if (liveVoiceNodeId === null) {
      Alert.alert("No devices connected", NO_DEVICES_COPY);
      return;
    }
    enterVoice("live");
    void startLiveConversation({
      nodeId: liveVoiceNodeId,
      onNotice: (message) => Alert.alert("Live conversation", message),
    }).then((started) => {
      if (!started) exitVoice();
    });
  }, [enterVoice, exitVoice, liveVoiceNodeId]);

  const endLiveConversation = useCallback(() => {
    void stopLiveConversation();
  }, []);

  // The one action the no-device state offers, shared by the banner pill and
  // the empty-state card.
  const openDeviceSettings = useCallback(() => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsEnvironments" },
    });
  }, [navigation]);

  // Leaving the voice surface must end a live conversation, not just hide it:
  // walking away with the microphone open and the session billing is not a
  // close. Dictation has nothing to release, so it only needs the reverse
  // animation.
  const closeVoiceSurface = useCallback(() => {
    if (isLiveConversationActive()) {
      endLiveConversation();
      return;
    }
    exitVoice();
  }, [endLiveConversation, exitVoice]);

  // The session drives the surface: a remote or idle close must bring the home
  // chrome back instead of leaving the scene stuck on a dead conversation.
  useEffect(() => {
    if (live.active) {
      if (modeRef.current === "home") enterVoice("live");
      return;
    }
    if (modeRef.current !== "home") exitVoice();
  }, [enterVoice, exitVoice, live.active]);

  // Android back leaves the listening surface instead of the app while the
  // scene owns voice. The X button does the same on both platforms.
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (modeRef.current === "home") return false;
      closeVoiceSurface();
      return true;
    });
    return () => subscription.remove();
  }, [closeVoiceSurface]);

  const submit = useCallback(async () => {
    // Every path below reaches a node RPC. With no device connected there is
    // nothing to reach, so say that instead of letting the attempt fail.
    if (!hasDevice) {
      controller.setMessage(NO_DEVICES_COPY);
      return;
    }
    // A correction typed while the previous request still submits cancels
    // that request first through the pre-accept wire; the retained text stays
    // for resend or follow-up instead of being silently dropped.
    if (controller.submitting) {
      await controller.cancelInflightRequest();
      return;
    }
    const turn = controller.createTextTurn();
    await controller.runInstruction(turn, utterance);
    setUtterance("");
  }, [controller, hasDevice, utterance]);

  // Done means stop the mic, transcribe what was captured, and run it as a
  // turn through the same pipeline typed text uses. The reply lands in the
  // message lane below. A dropped session (the user cancelled mid-transcribe)
  // abandons the result instead of submitting behind their back.
  const finishVoice = useCallback(() => {
    void (async () => {
      setVoiceNotice(null);
      setVoiceBusyLabel("Transcribing…");
      let uri: string | null = null;
      try {
        uri = await stopAndCaptureUri();
      } catch {
        uri = null;
      }
      const abort = new AbortController();
      try {
        const outcome = await transcribeCapturedVoice(uri, {
          getTranscriber: getLocalVoiceTranscriber,
          signal: abort.signal,
        });
        if (modeRef.current === "home") return;
        if (outcome.status === "ready") {
          const text = outcome.text;
          exitVoice();
          setVoiceBusyLabel(null);
          // The transcription is local, but running the turn is not. Keep the
          // words out of the void and say why nothing happened.
          if (!hasDevice) {
            controller.setMessage(NO_DEVICES_COPY);
            return;
          }
          const turn = controller.createTextTurn();
          await controller.runInstruction(turn, text);
          return;
        }
        setVoiceBusyLabel(null);
        setVoiceNotice(
          outcome.status === "unavailable"
            ? "Voice transcription isn't available on this device yet. Type instead."
            : "I didn't catch that. Try again or type instead.",
        );
      } catch {
        if (modeRef.current === "home") return;
        setVoiceBusyLabel(null);
        setVoiceNotice("Voice transcription failed. Try again or type instead.");
      } finally {
        if (uri) {
          try {
            new File(uri).delete();
          } catch {
            // Best-effort temp cleanup; a leftover recording is harmless.
          }
        }
      }
    })();
  }, [controller, exitVoice, hasDevice, stopAndCaptureUri]);

  const hasOnlineNode = hasDevice;

  // Home chrome drifts down and away; the listening layer rises into place.
  // Both read the same progress so exit is entry in reverse, for free.
  const homeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(voiceProgress.value, [0, 0.45], [1, 0], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(voiceProgress.value, [0, 0.45], [0, 10], Extrapolation.CLAMP) },
    ],
  }));
  const tabsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(voiceProgress.value, [0, 0.35], [1, 0], Extrapolation.CLAMP),
  }));
  const sceneBackgroundStyle = useAnimatedStyle(() => ({
    opacity: interpolate(voiceProgress.value, [0.05, 0.55], [0, 1], Extrapolation.CLAMP),
  }));

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-screen"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={100}
    >
      <NativeStackScreenOptions options={{ headerShown: false }} />

      {/* Warm espresso settles over the home surface as voice takes over. */}
      <Animated.View
        pointerEvents="none"
        style={[
          { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: ESPRESSO },
          sceneBackgroundStyle,
        ]}
      />

      <View style={{ paddingTop: insets.top }}>
        <SceneTopBar
          progress={voiceProgress}
          voiceActive={voiceActive}
          hasOnlineNode={hasOnlineNode}
          onOpenAccount={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          onCloseVoice={closeVoiceSurface}
          onConnectDevice={openDeviceSettings}
        />
      </View>

      <View style={{ flex: 1 }} onLayout={onSceneLayout}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          scrollEnabled={surfaceMode === "home"}
          onScroll={onSceneScroll}
          scrollEventThrottle={16}
          contentContainerStyle={{
            gap: 16,
            paddingHorizontal: 20,
            paddingTop: 10,
            paddingBottom: Math.max(insets.bottom, 18) + 28,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View style={homeStyle} pointerEvents={voiceActive ? "none" : "auto"}>
            <AssistantGreeting />
          </Animated.View>

          <SceneOrb
            progress={voiceProgress}
            voiceOrbShift={voiceOrbShift}
            fieldReveal={fieldReveal}
            orbState={orbState}
            level={level}
            appearance={themeAppearance}
            interactive={hasDevice && !voiceActive}
            onPress={() => enterVoice("dictation")}
            onLayout={onOrbLayout}
          />

          <Animated.View style={homeStyle} pointerEvents={voiceActive ? "none" : "auto"}>
            <CirceNeedsAttention
              desk={controller.desk}
              onFocusTask={(threadId) => {
                const task =
                  controller.desk === null
                    ? undefined
                    : [
                        ...(controller.desk.focusedTask === null
                          ? []
                          : [controller.desk.focusedTask]),
                        ...controller.desk.recentTasks,
                      ].find((candidate) => candidate.threadId === threadId);
                if (task !== undefined) void controller.focusTask(task);
              }}
            />
            <CirceMemories project={controller.selectedProject} />
          </Animated.View>

          {devicesConnecting ? (
            // The environment registry is the honest source for "still coming
            // up". The Circe catalog can be non-null with no reachable node
            // while a saved environment reconnects, which is what made the
            // no-device card flash and then vanish.
            <Animated.View style={homeStyle} pointerEvents={voiceActive ? "none" : "auto"}>
              <View className="flex-row items-center justify-center gap-2 rounded-2xl border border-border-subtle bg-card px-5 py-6">
                <ActivityIndicator size="small" color="#B9AFA6" />
                <Text className="text-sm text-foreground-muted">Connecting to your devices…</Text>
              </View>
            </Animated.View>
          ) : !hasDevice ? (
            // With no device, every control below would be a lie: the
            // conversation row cannot mint a session, the composer cannot
            // reach a node, and a quick action cannot run. The whole control
            // stack is replaced by the one thing the user can act on.
            <Animated.View style={homeStyle} pointerEvents={voiceActive ? "none" : "auto"}>
              <View className="items-center gap-1 rounded-2xl border border-border-subtle bg-card px-5 py-6">
                <SymbolView
                  name="exclamationmark.triangle.fill"
                  size={22}
                  tintColorClassName="accent-icon-muted"
                />
                <Text className="pt-1 text-base font-t3-bold text-foreground">
                  No devices connected
                </Text>
                <Text className="text-center text-sm leading-snug text-foreground-muted">
                  Circe runs work on your machines. Connect a device to talk, ask questions, or
                  start a task.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Connect a device"
                  onPress={openDeviceSettings}
                  className="mt-3 min-h-11 items-center justify-center rounded-full bg-circe-copper px-5 active:opacity-70"
                >
                  <Text className="text-sm font-t3-bold" style={{ color: "#FFFDF9" }}>
                    Connect a device
                  </Text>
                </Pressable>
              </View>
            </Animated.View>
          ) : (
            <Animated.View style={homeStyle} pointerEvents={voiceActive ? "none" : "auto"}>
              {/* Live conversation is the speech-to-speech path: one session the
                  node mints, with the model listening and speaking at once. The
                  orb above is push-to-talk dictation, which is a different mode. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Start live conversation"
                onPress={beginLiveConversation}
                className="flex-row items-center gap-3 rounded-2xl border border-border-subtle bg-card px-4 py-3 active:opacity-70"
              >
                <SymbolView name="mic.fill" size={20} tintColorClassName="accent-icon" />
                <View className="min-w-0 flex-1">
                  <Text className="text-base font-t3-bold text-foreground">Live conversation</Text>
                  <Text className="text-xs leading-snug text-foreground-muted">
                    Talk with Circe out loud. Interrupt any time.
                  </Text>
                </View>
                <SymbolView name="chevron.right" size={14} tintColorClassName="accent-icon-muted" />
              </Pressable>

              <View className="flex-row items-center gap-2 rounded-2xl border border-border-subtle bg-card py-2 pl-4 pr-2">
                <TextInput
                  ref={composerRef}
                  accessibilityLabel="Circe command"
                  className="min-h-11 flex-1 text-base text-foreground"
                  onChangeText={setUtterance}
                  onSubmitEditing={() => void submit()}
                  placeholder="Message Circe…"
                  placeholderTextColorClassName="accent-placeholder"
                  returnKeyType="send"
                  value={utterance}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    controller.submitting ? "Cancel in-flight request" : "Send Circe command"
                  }
                  onPress={() => void submit()}
                  disabled={utterance.trim() === "" && !controller.submitting}
                  className={`h-11 w-11 items-center justify-center rounded-full active:opacity-70 ${
                    utterance.trim() === "" && !controller.submitting
                      ? "bg-subtle"
                      : "bg-circe-copper"
                  }`}
                >
                  <SymbolView
                    name={controller.submitting ? "stop.fill" : "arrow.up"}
                    size={18}
                    tintColor="#FFFDF9"
                    type="monochrome"
                  />
                </Pressable>
              </View>

              {/* The reply lane. Turn results, submission state, and node errors
                  all land in `message`; without this nothing the user sends —
                  typed or spoken — ever visibly answers. */}
              {controller.message ? (
                <View className="mt-3 rounded-2xl border border-border-subtle bg-card px-4 py-3">
                  <Text className="text-sm leading-relaxed text-foreground">
                    {controller.message}
                  </Text>
                </View>
              ) : null}

              <View className="flex-row gap-2 pt-4">
                {QUICK_ACTIONS.map((action) => (
                  <Pressable
                    key={action.label}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    onPress={() => setUtterance(action.prompt)}
                    className="flex-1 items-center gap-2 rounded-2xl border border-border-subtle bg-card px-1 py-3.5 active:opacity-70"
                  >
                    <SymbolView name={action.icon} size={20} tintColorClassName="accent-icon" />
                    <Text className="text-center text-3xs font-t3-bold leading-tight text-foreground-muted">
                      {action.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </Animated.View>
          )}
        </ScrollView>

        {voiceActive ? (
          <View
            pointerEvents="box-none"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              paddingHorizontal: 0,
              paddingTop: 8,
              paddingBottom: 12,
            }}
          >
            {voiceOwner === "live" ? (
              <LiveConversationChrome
                progress={voiceProgress}
                status={live.status}
                caption={live.caption}
                onEnd={endLiveConversation}
              />
            ) : (
              <ListeningChrome
                progress={voiceProgress}
                phase={voiceNotice ? "error" : phase}
                errorMessage={voiceNotice ?? errorMessage}
                busyLabel={voiceBusyLabel}
                onTypeInstead={typeInstead}
                onCancel={exitVoice}
                onDone={finishVoice}
              />
            )}
          </View>
        ) : null}
      </View>

      <Animated.View style={tabsStyle} pointerEvents={voiceActive ? "none" : "auto"}>
        <CirceTabBar selected="home" />
      </Animated.View>
    </KeyboardAvoidingView>
  );
}

/**
 * The one persistent orb. It renders at a stable size for its whole life; only
 * this wrapper scales and travels, so the Skia scene never rebuilds
 * mid-transition. Its measured home position is reported upward so entering
 * voice can bring it to the middle of the scene.
 */
function SceneOrb({
  progress,
  voiceOrbShift,
  fieldReveal,
  orbState,
  level,
  appearance,
  interactive,
  onPress,
  onLayout,
}: {
  readonly progress: SharedValue<number>;
  readonly voiceOrbShift: SharedValue<number>;
  readonly fieldReveal: SharedValue<number>;
  readonly orbState: Parameters<typeof CirceOrb>[0]["state"];
  readonly level: Parameters<typeof CirceOrb>[0]["level"];
  readonly appearance: Parameters<typeof CirceOrb>[0]["appearance"];
  readonly interactive: boolean;
  readonly onPress: () => void;
  readonly onLayout: (event: LayoutChangeEvent) => void;
}) {
  const wrapStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          progress.value,
          [0, 1],
          [0, voiceOrbShift.value],
          Extrapolation.CLAMP,
        ),
      },
      {
        scale: interpolate(
          progress.value,
          [0, 1],
          [1, VOICE_ORB_SIZE / HOME_ORB_SIZE],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  return (
    <View className="items-center justify-center py-2" onLayout={onLayout}>
      <Animated.View style={wrapStyle}>
        <CirceOrb
          state={orbState}
          size={HOME_ORB_SIZE}
          level={level}
          fieldReveal={fieldReveal}
          interactive={interactive}
          appearance={appearance}
          onPress={onPress}
          voiceMeter
          accessibilityLabel="Talk to Circe"
        />
      </Animated.View>
    </View>
  );
}

/**
 * Custom top bar. The brand stays physically put while the right control
 * cross-fades between account and close, so voice entry keeps its anchor.
 * The readiness pill only exists when something is actually wrong.
 */
function SceneTopBar({
  progress,
  voiceActive,
  hasOnlineNode,
  onOpenAccount,
  onCloseVoice,
  onConnectDevice,
}: {
  readonly progress: SharedValue<number>;
  readonly voiceActive: boolean;
  readonly hasOnlineNode: boolean;
  readonly onOpenAccount: () => void;
  readonly onCloseVoice: () => void;
  readonly onConnectDevice: () => void;
}) {
  const accountStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.3], [1, 0], Extrapolation.CLAMP),
  }));
  const closeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.3, 0.6], [0, 1], Extrapolation.CLAMP),
  }));
  const offlineStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.3], [1, 0], Extrapolation.CLAMP),
  }));

  return (
    // The side slots are equal width so the wordmark stays optically centered
    // whichever controls are present. The readiness pill lives in the left
    // slot, sized to fit on one line.
    <View className="flex-row items-center px-5 pb-1 pt-2">
      <View className="w-28 items-start justify-center">
        {!hasOnlineNode ? (
          <Animated.View style={offlineStyle} pointerEvents={voiceActive ? "none" : "auto"}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="No devices connected. Open environments settings."
              onPress={onConnectDevice}
              className="h-8 flex-row items-center gap-1.5 rounded-full border border-border-subtle bg-card px-2.5 active:opacity-70"
            >
              <SymbolView name="wifi.slash" size={13} tintColorClassName="accent-icon-muted" />
              <Text numberOfLines={1} className="text-2xs font-t3-bold text-foreground-muted">
                No devices
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
      </View>

      <View className="flex-1 items-center">
        <CirceHeaderTitle />
      </View>

      <View className="w-28 items-end justify-center">
        <View>
          {/* The account control fades out on voice entry but would otherwise
              stay hittable underneath the close control. Every other piece of
              home chrome already drops its pointer events the same way. */}
          <Animated.View style={accountStyle} pointerEvents={voiceActive ? "none" : "auto"}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open account settings"
              onPress={onOpenAccount}
              className="h-10 w-10 items-center justify-center rounded-full bg-subtle active:opacity-70"
            >
              <SymbolView
                name="person.crop.circle"
                size={20}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            </Pressable>
          </Animated.View>
          {voiceActive ? (
            <Animated.View style={[closeStyle, { position: "absolute", right: 0, top: 0 }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close voice"
                onPress={onCloseVoice}
                className="h-10 w-10 items-center justify-center rounded-full active:opacity-70"
                style={{ backgroundColor: "rgba(246, 242, 239, 0.12)" }}
              >
                <SymbolView name="xmark" size={18} tintColor={LISTENING_INK} type="monochrome" />
              </Pressable>
            </Animated.View>
          ) : null}
        </View>
      </View>
    </View>
  );
}
