import { createEnvironmentCommand } from "@circe/client/state/runtime";
import {
  lookupCirceQuickAnswer,
  startCirceVoiceLiveSession,
  releaseCirceVoiceLiveSession,
  renewCirceVoiceLiveSession,
} from "@circe/client-runtime/operations/circeLiveVoice";
import type {
  CirceLiveVoiceCreateInput,
  CirceLiveVoiceReleaseInput,
  CirceLiveVoiceRenewInput,
} from "@circe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circeLiveVoiceEnvironment = {
  lookup: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:quick-lookup",
    execute: (input: import("@circe/contracts").CirceQuickLookupInput) =>
      lookupCirceQuickAnswer(input),
  }),
  release: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:voice-live-release",
    execute: (input: CirceLiveVoiceReleaseInput) => releaseCirceVoiceLiveSession(input),
  }),
  renew: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:voice-live-renew",
    execute: (input: CirceLiveVoiceRenewInput) => renewCirceVoiceLiveSession(input),
  }),
  start: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:voice-live-start",
    execute: (input: CirceLiveVoiceCreateInput) => startCirceVoiceLiveSession(input),
  }),
};
