import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  canStartLiveConversation,
  getLiveConversationState,
  isLiveConversationActive,
  noteInLiveConversation,
  registerLiveConversationDelegate,
  resetLiveConversationForTests,
  setLiveConversationState,
  setLiveVoiceSink,
  speakInLiveConversation,
  submitLiveConversationDelegation,
  subscribeLiveConversation,
} from "./liveVoiceBridge";

/**
 * The live conversation seam the app depends on.
 *
 * WebRTC cannot run under a unit test; what matters here is the contract around
 * it. Speech is routed into a session only while one exists, and delegated
 * utterances reach the registered submission handler.
 */
describe("live conversation bridge", () => {
  beforeEach(() => {
    resetLiveConversationForTests();
  });

  it("starts idle and inactive", () => {
    expect(getLiveConversationState()).toEqual({ active: false, status: "idle", caption: null });
    expect(isLiveConversationActive()).toBe(false);
  });

  it("cannot start while a conversation is already running", () => {
    expect(canStartLiveConversation()).toBe(true);
    setLiveVoiceSink({ speak: vi.fn(), note: vi.fn() });
    expect(canStartLiveConversation()).toBe(false);
    expect(isLiveConversationActive()).toBe(true);
  });

  it("does not report speech without a session", () => {
    expect(speakInLiveConversation("done")).toBe(false);
    expect(() => noteInLiveConversation("working")).not.toThrow();
  });

  it("speaks through the active session and stops once it ends", () => {
    const speak = vi.fn();
    setLiveVoiceSink({ speak, note: vi.fn() });
    expect(speakInLiveConversation("Task finished.")).toBe(true);
    expect(speak).toHaveBeenCalledWith("Task finished.");

    setLiveVoiceSink(null);
    expect(speakInLiveConversation("late")).toBe(false);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("hands delegated utterances to the registered handler", () => {
    const handler = vi.fn(() => true);
    const unsubscribe = registerLiveConversationDelegate(handler);
    expect(submitLiveConversationDelegation("summarise my work", "delegation-1")).toBe(true);
    expect(handler).toHaveBeenCalledWith("summarise my work", "delegation-1");

    unsubscribe();
    expect(submitLiveConversationDelegation("orphaned", "delegation-2")).toBe(false);
  });

  it("notifies subscribers on state changes and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLiveConversation(listener);
    setLiveConversationState({ active: true, status: "live", caption: "hello" });
    expect(listener).toHaveBeenCalledTimes(1);
    // Writing the same state again must not wake subscribers.
    setLiveConversationState({ active: true, status: "live", caption: "hello" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setLiveConversationState({ active: false, status: "idle", caption: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
