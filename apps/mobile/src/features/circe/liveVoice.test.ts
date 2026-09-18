import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The host loads the platform transport, the environment runtime, and the audio
// session. None has a native side under a unit test, so they are replaced with
// the smallest stand-ins that keep the module graph loadable. `react-native-webrtc`
// is deliberately left unmocked: its absence is the condition under test.
vi.mock("react-native", () => ({}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "test-uuid" }));
vi.mock("expo-audio", () => ({
  setAudioModeAsync: vi.fn(async () => undefined),
  setIsAudioActiveAsync: vi.fn(async () => undefined),
}));
vi.mock("../../state/circeLiveVoice", () => ({ circeLiveVoiceEnvironment: {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: vi.fn() }));

import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";

import { getLiveConversationState } from "./liveVoiceBridge";
import {
  liveConversationCloseNotice,
  resetLiveConversationHostForTests,
  startLiveConversation,
  stopLiveConversation,
} from "./liveVoice";

describe("live conversation host", () => {
  beforeEach(() => {
    resetLiveConversationHostForTests();
    vi.mocked(runAtomCommand).mockClear();
  });

  it("refuses to start when the build has no WebRTC native module", async () => {
    const onNotice = vi.fn();
    const started = await startLiveConversation({
      nodeId: EnvironmentId.make("node-1"),
      onNotice,
    });

    expect(started).toBe(false);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(String(onNotice.mock.calls[0]?.[0])).toContain("no live voice support");
    // No session is claimed and no RPC is attempted for a conversation this
    // build cannot hold.
    expect(getLiveConversationState()).toEqual({ active: false, status: "idle", caption: null });
    expect(runAtomCommand).not.toHaveBeenCalled();
  });

  it("stops cleanly when no conversation is running", async () => {
    await expect(stopLiveConversation()).resolves.toBeUndefined();
    expect(getLiveConversationState().active).toBe(false);
  });

  it("does not raise a notice when the user ends the conversation", () => {
    // The surface returns home on its own; a modal for an action the user just
    // took is noise.
    expect(liveConversationCloseNotice("user")).toBeNull();
    // Every other terminal reason still explains itself.
    expect(liveConversationCloseNotice("idle")).toContain("quiet spell");
    expect(liveConversationCloseNotice("max-duration")).toContain("time limit");
    expect(liveConversationCloseNotice("remote")).toContain("node ended");
  });

  it("reports a failure once, through onFailure, not again on close", () => {
    // `fail()` calls onFailure with the node's real message and then notifies
    // the close with "error". Surfacing both stacks a vague second modal on
    // top of the useful one, so the close notice stays silent for errors.
    expect(liveConversationCloseNotice("error")).toBeNull();
  });
});
