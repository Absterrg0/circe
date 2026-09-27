import { lookupCirceQuickAnswer } from "@circe/client-runtime/operations/circeLiveVoice";
import {
  cancelCirceMission,
  decideCirceComputerAccess,
  executeCirceInstruction,
  sayToCirceHost,
  stopCirceComputerAccess,
  useCirceBrowser,
  useCirceComputer,
} from "@circe/client-runtime/operations/circe";
import {
  createEnvironmentCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@circe/client/state/runtime";
import { WS_METHODS } from "@circe/contracts";
import type {
  CirceBrowserUseInput,
  CirceCancelMissionInput,
  CirceComputerAccessDecideInput,
  CirceComputerAccessStopInput,
  CirceExecuteInput,
  CirceHostSayInput,
} from "@circe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { uuidv4 } from "../lib/uuid";

/**
 * This app session as the origin of its Circe messages. Circe asks some
 * questions of one device only, such as whether to use the computer, and
 * only this session's spoken answer settles those.
 */
export const circeHostOrigin = uuidv4();

const presentedComputerRequests = new Map<string, string>();

/**
 * The request to use each node's computer that this phone is showing. A
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
  lookup: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:quick-lookup",
    execute: (input: import("@circe/contracts").CirceQuickLookupInput) =>
      lookupCirceQuickAnswer(input),
  }),
  hostSay: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:host-say",
    execute: (input: CirceHostSayInput) =>
      sayToCirceHost({ ...input, origin: input.origin ?? circeHostOrigin }),
  }),
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:execute",
    execute: (input: CirceExecuteInput) => executeCirceInstruction(input),
  }),
  browserUse: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:browser-use",
    execute: (input: CirceBrowserUseInput) => useCirceBrowser(input),
  }),
  computerUse: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:computer-use",
    execute: (input: import("@circe/contracts").CirceComputerUseInput) => useCirceComputer(input),
  }),
  cancelMission: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:cancel-mission",
    execute: (input: CirceCancelMissionInput) => cancelCirceMission(input),
  }),
  // What a node's Circe host says on its own, such as a coding agent asking
  // for the computer. Live only: a remount never repeats an old notice.
  hostNotices: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:host-notice-stream",
    tag: WS_METHODS.subscribeCirceHostNotices,
    idleTtlMs: 0,
  }),
  // Who uses a node's computer and what waits for approval, current state
  // first, so this phone can answer a request made anywhere.
  computerAccess: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:computer-access-stream",
    tag: WS_METHODS.subscribeCirceComputerAccess,
  }),
  decideComputerAccess: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:computer-access-decide",
    execute: (input: CirceComputerAccessDecideInput) => decideCirceComputerAccess(input),
  }),
  stopComputerAccess: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:computer-access-stop",
    execute: (input: CirceComputerAccessStopInput) => stopCirceComputerAccess(input),
  }),
  presentations: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:presentation-stream",
    tag: WS_METHODS.subscribeCircePresentation,
    idleTtlMs: 0,
  }),
};
