import type {
  CirceLiveVoiceCloseReason,
  CirceLiveVoiceController,
} from "@circe/client-runtime/circe/liveVoiceController";
import { createCirceLiveVoiceController } from "@circe/client-runtime/circe/liveVoiceController";
import { circeLiveVoiceCaption } from "@circe/client-runtime/circe/liveVoice";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { appAtomRegistry } from "../../state/atom-registry";
import { circeLiveVoiceEnvironment } from "../../state/circeLiveVoice";
import {
  createLiveVoiceWebrtcBrowser,
  isLiveVoiceWebrtcAvailable,
} from "../../native/liveVoiceWebrtc";
import { configureVoiceAudioForCapture, releaseVoiceAudio } from "../voice-input/voiceAudioSession";
import {
  resetLiveConversationState,
  setLiveConversationState,
  setLiveVoiceSink,
  submitLiveConversationDelegation,
} from "./liveVoiceBridge";

/**
 * The mobile GPT-Live host.
 *
 * A live conversation is one full-duplex speech-to-speech session. The live
 * model owns speech, and every project or task decision it makes is delegated
 * back through the ordinary submission queue, so grounding, clarification, and
 * approvals behave exactly as a typed turn. Backend results return as commentary
 * the model speaks, which is why this path needs no text-to-speech lane.
 *
 * The protocol state machine lives in `@circe/client-runtime`, shared with the
 * renderer. This module is the phone's host for it: the React Native media
 * transport, the environment RPCs, and the audio session. UI state and consumer
 * seams live in `liveVoiceBridge` so importing a screen never loads WebRTC.
 */

export type { LiveConversationState } from "./liveVoiceBridge";
export {
  canStartLiveConversation,
  isLiveConversationActive,
  useLiveConversation,
} from "./liveVoiceBridge";

let controller: CirceLiveVoiceController | null = null;
let starting = false;
// Bumped by every start and stop. A start that awaits the platform audio
// session re-checks this before it publishes a session, so a stop (or a newer
// start) that lands during the await cannot be overtaken.
let generation = 0;

// The media stack is probed only when a conversation is actually requested.
// Loading it initializes WebRTC's native audio stack, so a client that never
// starts a conversation must never touch it.
const UNAVAILABLE_COPY =
  "This build has no live voice support. Reinstall the current Circe app to use live conversation.";

/**
 * The notice for a session that ended, or null when it needs none.
 *
 * - The user ending a conversation is the expected exit, so it returns home
 *   silently instead of raising a modal for something they just did.
 * - A failure is reported once, by `onFailure`, with the node's actual message.
 *   Repeating it as a generic "the conversation stopped" is a second modal for
 *   the same event, and the vague one is what the user ends up reading.
 */
export function liveConversationCloseNotice(reason: CirceLiveVoiceCloseReason): string | null {
  switch (reason) {
    case "user":
    case "error":
      return null;
    case "idle":
      return "Live conversation ended after a quiet spell.";
    case "max-duration":
      return "Live conversation reached its time limit.";
    case "remote":
      return "The node ended the live conversation.";
  }
}

export interface StartLiveConversationInput {
  readonly nodeId: EnvironmentId;
  readonly onNotice: (message: string) => void;
}

/**
 * Start one conversation on the given node. Failure is reported through
 * `onNotice` and never leaves a half-built session behind.
 */
export async function startLiveConversation(input: StartLiveConversationInput): Promise<boolean> {
  if (controller !== null || starting) return controller !== null;
  if (!isLiveVoiceWebrtcAvailable()) {
    input.onNotice(UNAVAILABLE_COPY);
    return false;
  }
  const browser = createLiveVoiceWebrtcBrowser();
  if (browser === null) {
    input.onNotice("Live voice is unavailable in this build.");
    return false;
  }

  // Opening the audio session awaits the platform, and the user can end the
  // conversation inside that window. `generation` lets this start detect that a
  // stop superseded it, so a cancelled request cannot still open the microphone
  // and bill a session.
  const myGeneration = (generation += 1);
  starting = true;
  setLiveConversationState({ active: true, status: "requesting", caption: null });
  try {
    // The microphone opens inside the controller; put the audio session in its
    // capture shape first so the first utterance is not lost to the switch.
    await configureVoiceAudioForCapture();
  } catch {
    if (myGeneration === generation) {
      starting = false;
      resetLiveConversationState();
      input.onNotice("Could not start live voice on this device.");
    }
    return false;
  }

  if (myGeneration !== generation) {
    // A stop landed while the audio session was opening. If nothing newer is
    // running, undo the capture configuration this start just applied; if a
    // newer start already owns the session, leave its audio alone.
    if (!starting && controller === null) {
      await releaseVoiceAudio().catch(() => undefined);
    }
    return false;
  }

  const releaseSession = async (sessionId: string): Promise<void> => {
    const result = await runAtomCommand(
      appAtomRegistry,
      circeLiveVoiceEnvironment.release,
      { environmentId: input.nodeId, input: { sessionId } },
      { label: "mobile:circe:live-voice-release", reportFailure: false, reportDefect: false },
    );
    if (result._tag === "Failure") throw new Error(liveVoiceFailureMessage(result));
  };

  const session = createCirceLiveVoiceController({
    browser,
    start: async (createInput) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        circeLiveVoiceEnvironment.start,
        { environmentId: input.nodeId, input: createInput },
        { label: "mobile:circe:live-voice-start", reportFailure: false, reportDefect: false },
      );
      if (result._tag === "Failure") throw new Error(liveVoiceFailureMessage(result));
      return result.value;
    },
    release: releaseSession,
    renew: async (sessionId) => {
      // Best-effort: a renew failure must not tear down a live conversation.
      // The node closes the session only when renewals stop entirely.
      await runAtomCommand(
        appAtomRegistry,
        circeLiveVoiceEnvironment.renew,
        { environmentId: input.nodeId, input: { sessionId } },
        { label: "mobile:circe:live-voice-renew", reportFailure: false, reportDefect: false },
      );
    },
    delegate: (utterance, delegationId) =>
      submitLiveConversationDelegation(utterance, delegationId),
    onStatus: (status) => {
      setLiveConversationState({ active: status !== "failed", status, caption: null });
    },
    onTranscript: (transcript) => {
      // The caption follows whoever spoke last and is derived from a bounded
      // tail, never from the cumulative session transcript.
      setLiveConversationState({
        active: true,
        status: "live",
        caption: circeLiveVoiceCaption(transcript),
      });
    },
    onFailure: (message) => {
      input.onNotice(message);
    },
    // Idle, maximum-duration, and remote closes must release the surface too,
    // or the UI keeps claiming a conversation that is already gone.
    onClosed: (reason) => {
      controller = null;
      setLiveVoiceSink(null);
      void releaseVoiceAudio().catch(() => undefined);
      resetLiveConversationState();
      const notice = liveConversationCloseNotice(reason);
      if (notice !== null) input.onNotice(notice);
    },
  });

  // The sink is what makes a conversation observable to the rest of the app, so
  // it is published only once the session exists.
  controller = session;
  setLiveVoiceSink({ speak: session.speak, note: session.note });
  starting = false;
  await session.start();
  // A stop can land inside `session.start()`. Report the session that is
  // actually owned now, not the intent to start one.
  return controller === session;
}

export async function stopLiveConversation(): Promise<void> {
  // Supersede an in-flight start so it cannot publish a session after this
  // stop. Clearing `starting` stops the surface waiting on it immediately.
  generation += 1;
  starting = false;
  const session = controller;
  controller = null;
  setLiveVoiceSink(null);
  resetLiveConversationState();
  await session?.close().catch(() => undefined);
  await releaseVoiceAudio().catch(() => undefined);
}

function liveVoiceFailureMessage(result: unknown): string {
  const cause = (result as { readonly failure?: unknown }).failure;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof (cause as { readonly message?: unknown }).message === "string" &&
    (cause as { readonly message: string }).message.trim().length > 0
  ) {
    return (cause as { readonly message: string }).message;
  }
  return "Live voice could not start on this node. Check that it is online.";
}

/** Test seam: clears the host between cases. */
export function resetLiveConversationHostForTests(): void {
  controller = null;
  starting = false;
  generation = 0;
}
