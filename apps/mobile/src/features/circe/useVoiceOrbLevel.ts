import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { requestRecordingPermissionsAsync, RecordingPresets, useAudioRecorder } from "expo-audio";

import {
  applyNoiseFloor,
  createLevelSmoother,
  responseCurve,
} from "../../components/circe-orb/audioLevel";
import type { CirceOrbState } from "../../components/circe-orb/types";
import { normalizeVoiceInputDecibels } from "../voice-input/voiceInputMetering";

/**
 * 20 Hz. The metering interval is the orb's reaction time to a voice, so it is
 * set below the point where an onset is visible as a delay rather than a
 * response. Nothing per-sample reaches React: only the level shared value.
 */
const METERING_INTERVAL_MS = 50;

export type VoiceScreenPhase = CirceOrbState;

/**
 * Live microphone level for the voice orb. Requests permission, records while
 * mounted, and writes smoothed 0..1 levels into a Reanimated shared value so
 * no React render happens per meter sample. Only elapsed seconds and terminal
 * phase changes re-render.
 */
export function useVoiceOrbLevel(active: boolean): {
  readonly level: ReturnType<typeof useSharedValue<number>>;
  readonly phase: VoiceScreenPhase;
  readonly errorMessage: string | null;
  readonly elapsedLabel: string;
  /**
   * Stops the recorder and hands back the recording file URI, or null when
   * nothing was captured. The caller owns transcription from there; the hook
   * only ever metered the mic and discarded the file, which is why speaking
   * never got a reply.
   */
  readonly stopAndCaptureUri: () => Promise<string | null>;
} {
  const levelSV = useSharedValue(0);
  const [phase, setPhase] = useState<VoiceScreenPhase>("listening");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recordingUrlRef = useRef<string | null>(null);

  // A session can end in "error", and this hook is not remounted between
  // sessions. Clearing it in the effect below would leave the previous failure
  // committed for one frame, flashing its copy across the listening surface, so
  // the reset happens during render instead — the adjustment React documents
  // for state that depends on a prop. The condition is stored state, so it
  // converges after one extra render.
  const [sessionActive, setSessionActive] = useState(active);
  if (sessionActive !== active) {
    setSessionActive(active);
    if (active) {
      setPhase("listening");
      setErrorMessage(null);
      setElapsedSeconds(0);
    }
  }

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const smoother = createLevelSmoother();
    const startedAt = Date.now();
    let interval: ReturnType<typeof setInterval> | undefined;

    (async () => {
      const permission = await requestRecordingPermissionsAsync();
      if (cancelled) return;
      if (!permission.granted) {
        setErrorMessage("Microphone access is off. Enable it in Settings to speak to Circe.");
        setPhase("error");
        return;
      }
      try {
        await recorder.prepareToRecordAsync();
        if (cancelled) return;
        recorder.record();
      } catch {
        if (cancelled) return;
        setErrorMessage("Could not start listening. Try again.");
        setPhase("error");
        return;
      }
      interval = setInterval(() => {
        if (cancelled) return;
        const status = recorder.getStatus();
        if (!status.isRecording) return;
        if (status.url) recordingUrlRef.current = status.url;
        const raw = responseCurve(applyNoiseFloor(normalizeVoiceInputDecibels(status.metering)));
        levelSV.value = smoother.push(raw);
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        setElapsedSeconds((previous) => (previous === elapsed ? previous : elapsed));
      }, METERING_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (interval !== undefined) clearInterval(interval);
      levelSV.value = 0;
      void recorder.stop().catch(() => undefined);
    };
  }, [active, levelSV, recorder]);

  const stopAndCaptureUri = useCallback(async (): Promise<string | null> => {
    const liveUrl = (() => {
      try {
        return recorder.getStatus().url;
      } catch {
        return null;
      }
    })();
    const captured = recordingUrlRef.current ?? liveUrl;
    try {
      await recorder.stop();
    } catch {
      // Already stopped by cleanup or the OS; the captured URL still stands.
    }
    try {
      return recorder.getStatus().url ?? captured;
    } catch {
      return captured;
    }
  }, [recorder]);

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return {
    level: levelSV,
    phase,
    errorMessage,
    elapsedLabel: `${minutes}:${seconds}`,
    stopAndCaptureUri,
  };
}

export function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!cancelled) setReduced(value ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return reduced;
}
