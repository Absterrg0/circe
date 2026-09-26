import {
  executeCirceInstruction,
  listenToCirceHost,
  sayToCirceHost,
  speakWithCirceHost,
} from "@circe/client-runtime/operations/circe";
import { createEnvironmentCommand } from "@circe/client/state/runtime";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@circe/client/state/runtime";
import { WS_METHODS } from "@circe/contracts";
import type {
  CirceExecuteInput,
  CirceHostListenInput,
  CirceHostSayInput,
  CirceHostSpeakInput,
} from "@circe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circeEnvironment = {
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:execute",
    execute: (input: CirceExecuteInput) => executeCirceInstruction(input),
  }),
  hostSay: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:host-say",
    execute: (input: CirceHostSayInput) => sayToCirceHost(input),
  }),
  hostListen: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:host-listen",
    execute: (input: CirceHostListenInput) => listenToCirceHost(input),
  }),
  hostSpeak: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:host-speak",
    execute: (input: CirceHostSpeakInput) => speakWithCirceHost(input),
  }),
  // Live only, like presentations: a remount never speaks an old notice.
  hostNotices: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:circe:host-notice-stream",
    tag: WS_METHODS.subscribeCirceHostNotices,
    idleTtlMs: 0,
  }),
  presentations: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:circe:presentation-stream",
    tag: WS_METHODS.subscribeCircePresentation,
    // Presentation is live-only. Drop the atom immediately when the
    // Controller unmounts so an old terminal frame cannot be spoken after a
    // later remount.
    idleTtlMs: 0,
  }),
};
