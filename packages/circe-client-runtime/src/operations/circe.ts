import {
  WS_METHODS,
  type CirceBrowserUseInput,
  type CirceCancelMissionInput,
  type CirceCancelRequestInput,
  type CirceMemoryFetchInput,
  type CirceMemoryForgetInput,
  type CirceMemoryIndexInput,
  type CirceExecuteInput,
  type CirceFocusTaskInput,
  type CirceInterpretInput,
  type CirceManageProjectAliasInput,
  type CirceCoordinateInput,
  type CirceProjectGoalInput,
  type CirceProjectRef,
} from "@circe/contracts";
import * as Effect from "effect/Effect";

import { request } from "@circe/client/rpc";

/** Send one text or transcribed voice instruction to the T3 Circe manager. */
export const executeCirceInstruction = Effect.fn("Circe.executeInstruction")(function* (
  input: CirceExecuteInput,
) {
  return yield* request(WS_METHODS.circeExecute, input);
});

/**
 * One semantic inference before irreversible routing. Runs the semantic
 * node's configured supervisor over the verbatim source plus untrusted mesh
 * evidence and returns a typed proposal with no dispatch. Pins stay on the
 * owner node; the proposal never authorizes on its own.
 */
export const interpretCirceInstruction = Effect.fn("Circe.interpretInstruction")(function* (
  input: CirceInterpretInput,
) {
  return yield* request(WS_METHODS.circeInterpret, input);
});

/**
 * Cancel one pre-accept request by its exact request identity. Cancelled
 * means nothing was dispatched; already-accepted means the work runs under
 * the returned identity; unknown means nothing cancellable is known.
 */
export const cancelCirceRequest = Effect.fn("Circe.cancelRequest")(function* (
  input: CirceCancelRequestInput,
) {
  return yield* request(WS_METHODS.circeCancelRequest, input);
});

/**
 * Stop one running surface mission on its node by the mission's request id.
 * `cancelled` is true when a live mission held the id and will halt at its
 * next step boundary; false means it had already settled.
 */
export const cancelCirceMission = Effect.fn("Circe.cancelMission")(function* (
  input: CirceCancelMissionInput,
) {
  return yield* request(WS_METHODS.circeCancelMission, input);
});

/**
 * Run one bounded browser mission on an explicit node. The node drives its
 * connected desktop browser host through the TypeSafe step loop; the origin
 * client confirms once per session before the first mission.
 */
export const useCirceBrowser = Effect.fn("Circe.browserUse")(function* (
  input: CirceBrowserUseInput,
) {
  return yield* request(WS_METHODS.circeBrowserUse, input);
});

/**
 * Run one bounded desktop mission on an explicit node. The node drives its own
 * screen through the TypeSafe step loop over grounded accessibility elements;
 * the origin client confirms once per session before the first mission.
 */
export const useCirceComputer = Effect.fn("Circe.computerUse")(function* (
  input: import("@circe/contracts").CirceComputerUseInput,
) {
  return yield* request(WS_METHODS.circeComputerUse, input);
});

/** The compact project memory index: titles and costs, not bodies. */
export const getCirceMemoryIndex = Effect.fn("Circe.memoryIndex")(function* (
  input: CirceMemoryIndexInput,
) {
  return yield* request(WS_METHODS.circeMemoryIndex, input);
});

/** One memory body, returned already labeled with its provenance. */
export const fetchCirceMemory = Effect.fn("Circe.memoryFetch")(function* (
  input: CirceMemoryFetchInput,
) {
  return yield* request(WS_METHODS.circeMemoryFetch, input);
});

/** Retire one memory entry, keeping it in retired/ so provenance survives. */
export const forgetCirceMemory = Effect.fn("Circe.memoryForget")(function* (
  input: CirceMemoryForgetInput,
) {
  return yield* request(WS_METHODS.circeMemoryForget, input);
});

/** Read the authenticated device's Host-owned task focus and bounded history. */
export const getCirceTaskDesk = Effect.fn("Circe.getTaskDesk")(function* () {
  return yield* request(WS_METHODS.circeGetTaskDesk, {});
});

/** Focus one exact recent task without exposing thread selection to a model. */
export const focusCirceTask = Effect.fn("Circe.focusTask")(function* (input: CirceFocusTaskInput) {
  return yield* request(WS_METHODS.circeFocusTask, input);
});

/** Read live canonical names and Host-learned project pronunciations. */
export const getCirceProjectVocabulary = Effect.fn("Circe.getProjectVocabulary")(function* () {
  return yield* request(WS_METHODS.circeGetProjectVocabulary, {});
});

export const manageCirceProjectAlias = Effect.fn("Circe.manageProjectAlias")(function* (
  input: CirceManageProjectAliasInput,
) {
  return yield* request(WS_METHODS.circeManageProjectAlias, input);
});

/** Read one project's goal and pinned context without writing anything. */
export const getCirceProjectContext = Effect.fn("Circe.getProjectContext")(function* (
  input: CirceProjectRef,
) {
  return yield* request(WS_METHODS.circeGetProjectContext, input);
});

/** Set one project's goal and refresh the pinned workspace context. */
export const setCirceProjectGoal = Effect.fn("Circe.setProjectGoal")(function* (
  input: CirceProjectGoalInput,
) {
  return yield* request(WS_METHODS.circeSetProjectGoal, input);
});

/** Route one instruction through the project coordinator to a thread turn. */
export const coordinateCirceProject = Effect.fn("Circe.coordinate")(function* (
  input: CirceCoordinateInput,
) {
  return yield* request(WS_METHODS.circeCoordinate, input);
});
