import {
  decideCirceComputerAccess,
  executeCirceInstruction,
  listenToCirceHost,
  sayToCirceHost,
  speakWithCirceHost,
  stopCirceComputerAccess,
  transcribeWithCirceHost,
} from "@circe/client-runtime/operations/circe";
import { createEnvironmentCommand } from "@circe/client/state/runtime";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@circe/client/state/runtime";
import { WS_METHODS } from "@circe/contracts";
import type {
  CirceComputerAccessDecideInput,
  CirceComputerAccessStopInput,
  CirceExecuteInput,
  CirceHostListenInput,
  CirceHostSayInput,
  CirceHostSpeakInput,
  CirceHostTranscribeInput,
} from "@circe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { randomUUID } from "../lib/utils";

/**
 * This app session as the origin of its Circe messages. Circe asks some
 * questions of one device only, such as whether to use the computer, and
 * only this session's spoken answer settles those.
 */
export const circeHostOrigin = randomUUID();

const presentedComputerRequests = new Map<string, string>();

/**
 * The request to use each node's computer that this device is showing. A
 * spoken yes names it, so an agent's request that replaced the one the user
 * heard never gets their consent.
 */
export function setPresentedComputerRequest(nodeId: string, requestId: string | null): void {
  if (requestId === null) presentedComputerRequests.delete(nodeId);
  else presentedComputerRequests.set(nodeId, requestId);
}

/** The field a host message carries for the request shown for `nodeId`, if any. */
export function presentedComputerRequestFor(nodeId: string): {
  readonly presentedComputerRequest?: string;
} {
  const shown = presentedComputerRequests.get(nodeId);
  return shown === undefined ? {} : { presentedComputerRequest: shown };
}

export const circeEnvironment = {
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:execute",
    execute: (input: CirceExecuteInput) => executeCirceInstruction(input),
  }),
  hostSay: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:host-say",
    execute: (input: CirceHostSayInput) =>
      sayToCirceHost({ ...input, origin: input.origin ?? circeHostOrigin }),
  }),
  hostListen: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:host-listen",
    execute: (input: CirceHostListenInput) =>
      listenToCirceHost({ ...input, origin: input.origin ?? circeHostOrigin }),
  }),
  hostTranscribe: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:host-transcribe",
    execute: (input: CirceHostTranscribeInput) => transcribeWithCirceHost(input),
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
  // Who uses the node's computer and what waits for approval: the current
  // state on subscribe, so a reload or another device sees the same question.
  computerAccess: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:circe:computer-access-stream",
    tag: WS_METHODS.subscribeCirceComputerAccess,
  }),
  decideComputerAccess: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:computer-access-decide",
    execute: (input: CirceComputerAccessDecideInput) => decideCirceComputerAccess(input),
  }),
  stopComputerAccess: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:computer-access-stop",
    execute: (input: CirceComputerAccessStopInput) => stopCirceComputerAccess(input),
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
