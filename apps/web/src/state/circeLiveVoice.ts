import { createEnvironmentCommand } from "@circe/client/state/runtime";
import {
  lookupCirceQuickAnswer,
  startCirceVoiceLiveSession,
  releaseCirceVoiceLiveSession,
  renewCirceVoiceLiveSession,
} from "@circe/client-runtime/operations/circeLiveVoice";
import { cancelCirceMission, useCirceBrowser } from "@circe/client-runtime/operations/circe";
import type {
  CirceBrowserUseInput,
  CirceCancelMissionInput,
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
  browserUse: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:browser-use",
    execute: (input: CirceBrowserUseInput) => useCirceBrowser(input),
  }),
  cancelMission: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:cancel-mission",
    execute: (input: CirceCancelMissionInput) => cancelCirceMission(input),
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
