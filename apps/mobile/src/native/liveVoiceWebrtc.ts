import type {
  CirceLiveVoiceAudioElement,
  CirceLiveVoiceBrowser,
  CirceLiveVoiceMediaStream,
  CirceLiveVoicePeerConnection,
} from "@circe/client-runtime/circe/liveVoiceController";

import { uuidv4 } from "../lib/uuid";

/**
 * React Native transport for GPT-Live.
 *
 * The shared controller owns the session state machine and takes its media
 * surface through the `CirceLiveVoiceBrowser` seam, so this file only maps that
 * seam onto `react-native-webrtc`. Keeping the mapping here means the phone and
 * the browser run the same protocol code instead of two drifting copies.
 *
 * `react-native-webrtc` throws from its own module body when the native side is
 * missing. A dev client built before live voice shipped therefore has the JS
 * package but no `WebRTCModule`, and a static import would take the whole app
 * down on bundle load. The module is loaded lazily inside a guard instead, so an
 * older build keeps working and the UI can say what to update.
 */

type ReactNativeWebrtc = typeof import("react-native-webrtc");
type WebrtcTrack = ConstructorParameters<ReactNativeWebrtc["MediaStream"]>[0] extends
  | ReadonlyArray<infer T>
  | undefined
  ? T
  : never;

let cachedModule: ReactNativeWebrtc | null | undefined;

function loadWebrtcModule(): ReactNativeWebrtc | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    cachedModule = require("react-native-webrtc") as ReactNativeWebrtc;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** True when this build actually carries the WebRTC native module. */
export function isLiveVoiceWebrtcAvailable(): boolean {
  return loadWebrtcModule() !== null;
}

/**
 * Remote audio on React Native plays through the platform audio device; there
 * is no `HTMLAudioElement` to attach a stream to. The adapter still holds the
 * stream the controller assigns, so the native track stays referenced for the
 * life of the session and audio keeps flowing.
 */
function createAudioElement(): CirceLiveVoiceAudioElement {
  return {
    autoplay: true,
    srcObject: null,
    play: async () => undefined,
  };
}

export function createLiveVoiceWebrtcBrowser(): CirceLiveVoiceBrowser | null {
  const webrtc = loadWebrtcModule();
  if (webrtc === null) return null;

  return {
    // No ICE servers, matching the renderer: the offer is sent in full to the
    // node and relayed upstream, so host candidates are the baseline.
    createPeerConnection: () =>
      new webrtc.RTCPeerConnection({ iceServers: [] }) as unknown as CirceLiveVoicePeerConnection,
    createAudioElement,
    createMediaStream: (track) =>
      new webrtc.MediaStream([track as WebrtcTrack]) as unknown as CirceLiveVoiceMediaStream,
    getUserMedia: async () =>
      (await webrtc.mediaDevices.getUserMedia({
        audio: true,
      })) as unknown as CirceLiveVoiceMediaStream,
    /**
     * Announcement sessions speak a report without listening. React Native has
     * no zero-gain source to synthesize, so this returns a trackless stream and
     * no microphone opens. Announcement playback is not wired on mobile yet, and
     * user conversations never take this path.
     */
    createSilentStream: () => new webrtc.MediaStream() as unknown as CirceLiveVoiceMediaStream,
    createId: () => uuidv4(),
  };
}
