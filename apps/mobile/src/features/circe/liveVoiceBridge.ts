import type { CirceLiveVoiceStatus } from "@circe/client-runtime/circe/liveVoiceController";
import { useSyncExternalStore } from "react";

/**
 * The live conversation seam.
 *
 * Everything that is not transport lives here: the state the Circe surface
 * renders, the submission handler live speech delegates into, the sink backend
 * results are spoken through, and whether this build can hold a conversation at
 * all. The host that owns WebRTC and the node RPCs writes into this module, and
 * consumers depend only on it, so importing the UI never pulls a native media
 * stack into a test or a build that lacks one.
 */

export interface LiveConversationState {
  readonly active: boolean;
  readonly status: CirceLiveVoiceStatus;
  /** Last spoken words, bounded, for the on-screen caption. */
  readonly caption: string | null;
}

/** Append a result the live model should say aloud. */
export interface LiveVoiceSink {
  readonly speak: (text: string) => void;
  readonly note: (text: string) => void;
}

export type LiveVoiceDelegateHandler = (utterance: string, delegationId: string) => boolean;

const IDLE_STATE: LiveConversationState = { active: false, status: "idle", caption: null };

let state: LiveConversationState = IDLE_STATE;
let sink: LiveVoiceSink | null = null;
let delegate: LiveVoiceDelegateHandler | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A subscriber failure must not break session control.
    }
  }
};

export function subscribeLiveConversation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLiveConversationState(): LiveConversationState {
  return state;
}

/** Subscribes the Circe surface to conversation state. */
export function useLiveConversation(): LiveConversationState {
  return useSyncExternalStore(subscribeLiveConversation, getLiveConversationState);
}

/** Published by the host so the UI can render status without owning a session. */
export function setLiveConversationState(next: LiveConversationState): void {
  if (
    next.active === state.active &&
    next.status === state.status &&
    next.caption === state.caption
  ) {
    return;
  }
  state = next;
  emit();
}

export function resetLiveConversationState(): void {
  setLiveConversationState(IDLE_STATE);
}

/**
 * The active session's output, or null. Reports are spoken only while a session
 * exists, so a stale sink can never claim speech it cannot deliver.
 */
export function setLiveVoiceSink(next: LiveVoiceSink | null): void {
  sink = next;
}

export function getLiveVoiceSink(): LiveVoiceSink | null {
  return sink;
}

export function isLiveConversationActive(): boolean {
  return sink !== null;
}

/**
 * The one submission handler for delegated live utterances. Registered by the
 * Circe controller owner so live speech reuses the same queue, grounding, and
 * clarification state as typed input.
 */
export function registerLiveConversationDelegate(handler: LiveVoiceDelegateHandler): () => void {
  delegate = handler;
  return () => {
    if (delegate === handler) delegate = null;
  };
}

export function submitLiveConversationDelegation(utterance: string, delegationId: string): boolean {
  return delegate?.(utterance, delegationId) ?? false;
}

/** Returns false when no conversation is running to speak through. */
export function speakInLiveConversation(text: string): boolean {
  const current = sink;
  if (current === null) return false;
  current.speak(text);
  return true;
}

/** Quiet progress context the model may use without speaking it. */
export function noteInLiveConversation(text: string): void {
  sink?.note(text);
}

/**
 * Whether a conversation can be started right now. Availability of the media
 * stack is deliberately not probed here: reaching for the WebRTC module
 * initializes its native audio stack, so a client that never starts a
 * conversation must never touch it. The host probes at start time instead and
 * reports the reason.
 */
export function canStartLiveConversation(): boolean {
  return sink === null;
}

/** Test seam: clears module state between cases. */
export function resetLiveConversationForTests(): void {
  sink = null;
  delegate = null;
  state = IDLE_STATE;
}
