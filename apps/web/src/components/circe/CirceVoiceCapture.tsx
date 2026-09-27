import type { CirceHostRoute, CirceCommandTarget } from "../../circeBus";
import type { DesktopCirceLiveVoiceState, EnvironmentId, ThreadId } from "@circe/contracts";
import { useEffect, useRef } from "react";

import {
  getCirceTargetSnapshot,
  publishCirceCommandFeedback,
  submitCirceComposerCommand,
} from "../../circeBus";
import { randomUUID } from "../../lib/utils";
import { circeEnvironment, presentedComputerRequestFor } from "../../state/circe";
import { useAtomCommand } from "../../state/use-atom-command";
import { playCirceSpeech, stopCirceSpeech } from "./circeSpeechPlayer";
import { getCirceLiveVoiceUiState, setCirceLiveVoiceActive } from "./CirceLiveVoice.bridge";

/**
 * Circe voice on the desktop: hold the hotkey, talk, let go. The recording
 * goes to the node, which transcribes it through Circe Mesh and handles the
 * words; the reply is shown on the orb and spoken. Nothing here interprets
 * anything.
 */

/** A release sooner than this is a tap: it starts or ends a live conversation instead. */
const MIN_RECORDING_MS = 350;
/** A held key that never comes up still ends the message. */
const MAX_RECORDING_MS = 60_000;
/** How long the orb keeps showing what Circe said. */
const CAPTION_MS = 10_000;
const MIME_TYPE = "audio/webm;codecs=opus";

interface Recording {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly audioContext: AudioContext;
  readonly chunks: Blob[];
  readonly stopLevel: () => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    });
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("The recording could not be read.")),
    );
    reader.readAsDataURL(blob);
  });
}

export function CirceVoiceCapture({
  environmentId,
  routeTarget,
  hostRoute,
  onThreadStarted,
}: {
  readonly environmentId: EnvironmentId;
  readonly routeTarget: CirceCommandTarget | null;
  /** What the host layer is told is on screen, including bot pages. */
  readonly hostRoute?: CirceHostRoute | undefined;
  readonly onThreadStarted: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Promise<void> | void;
}) {
  const listen = useAtomCommand(circeEnvironment.hostListen, {
    reportFailure: false,
    reportDefect: false,
  });
  const speak = useAtomCommand(circeEnvironment.hostSpeak, {
    reportFailure: false,
    reportDefect: false,
  });
  const transcribe = useAtomCommand(circeEnvironment.hostTranscribe, {
    reportFailure: false,
    reportDefect: false,
  });
  const hostSay = useAtomCommand(circeEnvironment.hostSay, {
    reportFailure: false,
    reportDefect: false,
  });
  // The hotkey handlers are installed once; they read the latest props here.
  const latest = useRef({
    environmentId,
    routeTarget,
    hostRoute,
    onThreadStarted,
    listen,
    speak,
    transcribe,
    hostSay,
  });
  useEffect(() => {
    latest.current = {
      environmentId,
      routeTarget,
      hostRoute,
      onThreadStarted,
      listen,
      speak,
      transcribe,
      hostSay,
    };
  });

  useEffect(() => {
    const bridge = window.desktopBridge?.circeLiveVoice;
    if (bridge === undefined) return;
    let recording: Recording | null = null;
    let starting = false;
    let pressedAt = 0;
    // A press made while a live conversation runs; its release may end it.
    let pressedDuringLive = false;
    // A release that arrives while the microphone is still opening.
    let releasedWhileStarting = false;
    let turn = 0;
    let clearCaption: ReturnType<typeof setTimeout> | null = null;

    const report = (state: Omit<DesktopCirceLiveVoiceState, "enabled" | "mode">) =>
      bridge.report({ enabled: true, mode: "message", ...state });
    const settle = (caption: string | undefined, failed = false) => {
      report({
        active: false,
        status: failed ? "failed" : "idle",
        ...(caption === undefined ? {} : { caption }),
      });
      if (clearCaption !== null) clearTimeout(clearCaption);
      clearCaption = setTimeout(
        () => report({ active: false, status: "idle" }),
        failed ? 4_000 : CAPTION_MS,
      );
    };

    const press = () => {
      pressedAt = performance.now();
      // The live conversation already has the microphone.
      if (getCirceLiveVoiceUiState().active) {
        pressedDuringLive = true;
        return;
      }
      void start();
    };

    const release = () => {
      const tapped = performance.now() - pressedAt < MIN_RECORDING_MS;
      if (pressedDuringLive) {
        pressedDuringLive = false;
        if (tapped) setCirceLiveVoiceActive(false);
        return;
      }
      void finish(tapped);
    };

    const start = async () => {
      if (recording !== null || starting) return;
      starting = true;
      releasedWhileStarting = false;
      turn += 1;
      stopCirceSpeech();
      report({ active: true, status: "requesting", caption: "Listening…" });
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const recorder = new MediaRecorder(
          stream,
          MediaRecorder.isTypeSupported(MIME_TYPE) ? { mimeType: MIME_TYPE } : {},
        );
        const chunks: Blob[] = [];
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        // The orb follows the microphone level while Circe listens.
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        const samples = new Uint8Array(analyser.fftSize);
        const meter = setInterval(() => {
          analyser.getByteTimeDomainData(samples);
          let peak = 0;
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample - 128) / 128);
          report({
            active: true,
            status: "live",
            level: Math.min(1, peak * 2),
            caption: "Listening…",
          });
        }, 100);
        recorder.start();
        recording = {
          recorder,
          stream,
          audioContext,
          chunks,
          stopLevel: () => clearInterval(meter),
          timeout: setTimeout(() => void finish(false), MAX_RECORDING_MS),
        };
      } catch {
        settle("I can't use the microphone. Check that Circe is allowed to record audio.", true);
      } finally {
        starting = false;
      }
      if (releasedWhileStarting) void finish(performance.now() - pressedAt < MIN_RECORDING_MS);
    };

    const stopRecording = (current: Recording) =>
      new Promise<Blob>((resolve) => {
        current.recorder.addEventListener(
          "stop",
          () =>
            resolve(new Blob(current.chunks, { type: current.recorder.mimeType || "audio/webm" })),
          { once: true },
        );
        current.recorder.stop();
        current.stopLevel();
        clearTimeout(current.timeout);
        for (const track of current.stream.getTracks()) track.stop();
        void current.audioContext.close();
      });

    const finish = async (tapped: boolean) => {
      const current = recording;
      if (current === null) {
        if (starting) releasedWhileStarting = true;
        return;
      }
      recording = null;
      const audio = await stopRecording(current);
      if (tapped) {
        report({ active: false, status: "idle" });
        setCirceLiveVoiceActive(true);
        return;
      }
      if (audio.size === 0) {
        settle("I didn't hear anything.");
        return;
      }
      const thisTurn = turn;
      report({ active: true, status: "connecting", caption: "Thinking…" });
      const {
        environmentId: primary,
        hostRoute: onScreen,
        onThreadStarted: show,
        listen: send,
        speak: say,
        transcribe: toWords,
        hostSay: sendWords,
      } = latest.current;
      // The node that owns what is on screen handles it; with nothing on
      // screen, this machine's node. Speech stays on this machine's node,
      // which has the voice credentials: another node gets the words.
      // Without a thread on screen, what the control center shows.
      const shown = onScreen === undefined ? getCirceTargetSnapshot() : null;
      const node = onScreen?.environmentId ?? shown?.projectRef?.nodeId ?? primary;
      const focus =
        onScreen?.focus ??
        (shown?.projectRef == null
          ? undefined
          : {
              projectId: shown.projectRef.projectId,
              ...(shown.contextThreadId === undefined ? {} : { threadId: shown.contextThreadId }),
            });
      const encoded = await toBase64(audio);
      const reply = await (async () => {
        if (node === primary) {
          const result = await send({
            environmentId: node,
            input: {
              audio: encoded,
              mimeType: "audio/webm",
              ...(focus === undefined ? {} : { focus }),
              ...presentedComputerRequestFor(node),
            },
          });
          return result._tag === "Success" ? result.value : null;
        }
        const words = await toWords({
          environmentId: primary,
          input: { audio: encoded, mimeType: "audio/webm" },
        });
        if (words._tag !== "Success") return null;
        if (words.value.status === "failed") {
          return { status: "failed" as const, said: words.value.message, started: [], heard: "" };
        }
        const heard = words.value.heard.trim();
        if (heard.length === 0) {
          return {
            status: "failed" as const,
            said: "I didn't catch that.",
            started: [],
            heard: "",
          };
        }
        const answered = await sendWords({
          environmentId: node,
          input: {
            utterance: heard.slice(0, 16_000),
            ...(focus === undefined ? {} : { focus }),
            ...presentedComputerRequestFor(node),
          },
        });
        return answered._tag === "Success" ? { ...answered.value, heard } : null;
      })();
      if (thisTurn !== turn) return;
      if (reply === null) {
        settle(
          "I couldn't hear back, so it may or may not have acted. Check before asking again.",
          true,
        );
        return;
      }
      // A node without the host layer only transcribed the words; the voice
      // runtime carries them out through its own path.
      if (reply.status === "unavailable") {
        if (reply.heard.length === 0) {
          settle("I didn't catch that.", true);
          return;
        }
        submitCirceComposerCommand({
          text: reply.heard,
          inputMode: "voice",
          captureId: randomUUID(),
          sourceTranscript: reply.heard,
        });
        settle(reply.heard);
        return;
      }
      if (reply.heard.length > 0)
        publishCirceCommandFeedback({ inputMode: "voice", kind: "working", text: reply.heard });
      publishCirceCommandFeedback({
        inputMode: "voice",
        kind:
          reply.status === "asked" ? "needs-input" : reply.status === "acted" ? "done" : "error",
        text: reply.said,
      });
      if (reply.navigate?.threadId !== undefined) void show(node, reply.navigate.threadId);
      report({ active: true, status: "closing", caption: reply.said });
      const spoken = await say({
        environmentId: primary,
        input: { text: reply.said.slice(0, 4_000) },
      });
      if (thisTurn !== turn) return;
      if (spoken._tag === "Success" && spoken.value.audio.length > 0)
        await playCirceSpeech(spoken.value.audio);
      if (thisTurn !== turn) return;
      settle(reply.said, reply.status === "failed");
    };

    report({ active: false, status: "idle" });
    const removeHold = bridge.onHold?.((phase) => (phase === "press" ? press() : release()));
    return () => {
      removeHold?.();
      if (clearCaption !== null) clearTimeout(clearCaption);
      if (recording !== null) void stopRecording(recording);
      recording = null;
      stopCirceSpeech();
    };
  }, []);

  return null;
}
