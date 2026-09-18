import { lookupCirceQuickAnswer } from "@circe/client-runtime/operations/circeLiveVoice";
import { executeCirceInstruction } from "@circe/client-runtime/operations/circe";
import {
  createEnvironmentCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@circe/client/state/runtime";
import { WS_METHODS } from "@circe/contracts";
import type { CirceExecuteInput } from "@circe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circeEnvironment = {
  lookup: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:quick-lookup",
    execute: (input: import("@circe/contracts").CirceQuickLookupInput) =>
      lookupCirceQuickAnswer(input),
  }),
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:execute",
    execute: (input: CirceExecuteInput) => executeCirceInstruction(input),
  }),
  presentations: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "mobile:environment-data:circe:presentation-stream",
    tag: WS_METHODS.subscribeCircePresentation,
    idleTtlMs: 0,
  }),
};
