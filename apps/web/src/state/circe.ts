import {
  executeCirceInstruction,
  forgetCirceMemory,
  getCirceMemoryIndex,
} from "@circe/client-runtime/operations/circe";
import { createEnvironmentCommand } from "@circe/client/state/runtime";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@circe/client/state/runtime";
import { WS_METHODS } from "@circe/contracts";
import type {
  CirceExecuteInput,
  CirceMemoryForgetInput,
  CirceMemoryIndexInput,
} from "@circe/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const circeEnvironment = {
  execute: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:execute",
    execute: (input: CirceExecuteInput) => executeCirceInstruction(input),
  }),
  memoryIndex: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:memory-index",
    execute: (input: CirceMemoryIndexInput) => getCirceMemoryIndex(input),
  }),
  forgetMemory: createEnvironmentCommand(connectionAtomRuntime, {
    label: "environment-data:commands:circe:memory-forget",
    execute: (input: CirceMemoryForgetInput) => forgetCirceMemory(input),
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
