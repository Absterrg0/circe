import {
  releaseCirceVoiceLiveSession,
  renewCirceVoiceLiveSession,
  startCirceVoiceLiveSession,
} from "@circe/client-runtime/operations/circeLiveVoice";
import { createEnvironmentCommand } from "@circe/client/state/runtime";
import type {
  CirceLiveVoiceCreateInput,
  CirceLiveVoiceReleaseInput,
  CirceLiveVoiceRenewInput,
} from "@circe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Mobile transport for GPT-Live session lifecycle. The node owns the API key
 * and mints the session; the phone sends only its SDP offer and closes through
 * the node so a cloud reservation is freed on the relay.
 */
export const circeLiveVoiceEnvironment = {
  start: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:voice-live-start",
    execute: (input: CirceLiveVoiceCreateInput) => startCirceVoiceLiveSession(input),
  }),
  release: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:voice-live-release",
    execute: (input: CirceLiveVoiceReleaseInput) => releaseCirceVoiceLiveSession(input),
  }),
  renew: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:voice-live-renew",
    execute: (input: CirceLiveVoiceRenewInput) => renewCirceVoiceLiveSession(input),
  }),
};
