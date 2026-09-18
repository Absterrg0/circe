import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The host loads the platform transport, the environment runtime, and the audio
// session. None has a native side under a unit test, so they are replaced with
// the smallest stand-ins that keep the module graph loadable. The WebRTC probe
// is mocked rather than left to `react-native-webrtc`'s absence so a test can
// drive the available path; the unavailable path stays the default.
const webrtc = vi.hoisted(() => ({
  available: false,
  browser: null as unknown,
}));
vi.mock("../../native/liveVoiceWebrtc", () => ({
  isLiveVoiceWebrtcAvailable: () => webrtc.available,
  createLiveVoiceWebrtcBrowser: () => webrtc.browser,
}));

const voiceAudio = vi.hoisted(() => ({
  configure: null as null | (() => Promise<void>),
}));
vi.mock("../voice-input/voiceAudioSession", () => ({
  configureVoiceAudioForCapture: () => voiceAudio.configure?.() ?? Promise.resolve(),
  releaseVoiceAudio: vi.fn(async () => undefined),
}));

// The protocol controller is exercised by its own suite. Here it is a stand-in
// so the host's start/stop ownership can be observed without a media stack.
const session = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  speak: vi.fn(),
  note: vi.fn(),
}));
vi.mock("@circe/client-runtime/circe/liveVoiceController", () => ({
  createCirceLiveVoiceController: () => session,
}));

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("live conversation host", () => {
  beforeEach(() => {
    resetLiveConversationHostForTests();
    vi.mocked(runAtomCommand).mockClear();
    webrtc.available = false;
    webrtc.browser = null;
    voiceAudio.configure = null;
    session.start.mockClear();
    session.close.mockClear();
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

  it("does not start a session the user ends while the audio session opens", async () => {
    const capture = deferred<void>();
    voiceAudio.configure = () => capture.promise;
    webrtc.available = true;
    webrtc.browser = {};
    const onNotice = vi.fn();

    const starting = startLiveConversation({ nodeId: EnvironmentId.make("node-1"), onNotice });
    // End is pressed while `configureVoiceAudioForCapture` is still pending.
    const stopping = stopLiveConversation();
    capture.resolve();

    await expect(starting).resolves.toBe(false);
    await stopping;
    // A cancelled start must not open the microphone, bill a session, or claim
    // the surface.
    expect(runAtomCommand).not.toHaveBeenCalled();
    expect(session.start).not.toHaveBeenCalled();
    expect(getLiveConversationState()).toEqual({ active: false, status: "idle", caption: null });
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
