import type { CirceCommandTarget } from "../../circeBus";
import type { DesktopCirceLiveVoiceState, EnvironmentId, ThreadId } from "@circe/contracts";
import { useEffect, useRef } from "react";

import { publishCirceCommandFeedback } from "../../circeBus";
import { circeEnvironment } from "../../state/circe";
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
  onThreadStarted,
}: {
  readonly environmentId: EnvironmentId;
  readonly routeTarget: CirceCommandTarget | null;
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
  // The hotkey handlers are installed once; they read the latest props here.
  const latest = useRef({ environmentId, routeTarget, onThreadStarted, listen, speak });
  useEffect(() => {
    latest.current = { environmentId, routeTarget, onThreadStarted, listen, speak };
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
        environmentId: node,
        routeTarget: target,
        onThreadStarted: show,
        listen: send,
        speak: say,
      } = latest.current;
      const focus =
        target !== null && target.environmentId === node
          ? {
              projectId: target.projectId,
              ...(target.contextThreadId === undefined ? {} : { threadId: target.contextThreadId }),
            }
          : undefined;
      const result = await send({
        environmentId: node,
        input: {
          audio: await toBase64(audio),
          mimeType: "audio/webm",
          ...(focus === undefined ? {} : { focus }),
        },
      });
      if (thisTurn !== turn) return;
      if (result._tag !== "Success") {
        settle("I couldn't reach Circe on this machine.", true);
        return;
      }
      const reply = result.value;
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
        environmentId: node,
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
