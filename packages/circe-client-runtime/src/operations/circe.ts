import {
  WS_METHODS,
  type CirceBrowserUseInput,
  type CirceCancelMissionInput,
  type CirceComputerUseInput,
  type CirceCancelRequestInput,
  type CirceDeviceReadinessInput,
  type CirceExecuteInput,
  type CirceFocusTaskInput,
  type CirceHostListenInput,
  type CirceHostSayInput,
  type CirceHostSpeakInput,
  type CirceInterpretInput,
  type CirceInteractionInterruptInput,
  type CirceInteractionReadInput,
  type CirceInteractionSubmitInput,
  type CirceManageProjectAliasInput,
} from "@circe/contracts";
import * as Effect from "effect/Effect";

import { request } from "@circe/client/rpc";

/**
 * Submit one utterance to the node-owned interaction. The server resolves the
 * relation to the active goal, asks or answers the pending question, and
 * returns either state to render or a grounded proposal for ordinary work.
 */
export const submitCirceInteraction = Effect.fn("Circe.interactionSubmit")(function* (
  input: CirceInteractionSubmitInput,
) {
  return yield* request(WS_METHODS.circeInteractionSubmit, input);
});

/** Read the active interaction, or one exact interaction, from its owner node. */
export const readCirceInteraction = Effect.fn("Circe.interactionRead")(function* (
  input: CirceInteractionReadInput,
) {
  return yield* request(WS_METHODS.circeInteractionRead, input);
});

/** Stop the interaction's operation or pending question on its owner node. */
export const interruptCirceInteraction = Effect.fn("Circe.interactionInterrupt")(function* (
  input: CirceInteractionInterruptInput,
) {
  return yield* request(WS_METHODS.circeInteractionInterrupt, input);
});

/** Observed desktop readiness for this node; clients act only on ready surfaces. */
export const getCirceDeviceReadiness = Effect.fn("Circe.deviceReadiness")(function* (
  input: CirceDeviceReadinessInput,
) {
  return yield* request(WS_METHODS.circeDeviceReadiness, input);
});

/** Send one text or transcribed voice instruction to the T3 Circe manager. */
export const executeCirceInstruction = Effect.fn("Circe.executeInstruction")(function* (
  input: CirceExecuteInput,
) {
  return yield* request(WS_METHODS.circeExecute, input);
});

/**
 * One message to the node's Circe host layer, which interprets it against the
 * node's own projects and threads and carries it out there.
 */
export const sayToCirceHost = Effect.fn("Circe.hostSay")(function* (input: CirceHostSayInput) {
  return yield* request(WS_METHODS.circeHostSay, input);
});

/** One spoken message to the node's Circe host layer, transcribed through Circe Mesh. */
export const listenToCirceHost = Effect.fn("Circe.hostListen")(function* (
  input: CirceHostListenInput,
) {
  return yield* request(WS_METHODS.circeHostListen, input);
});

/** One Circe reply as speech, synthesized through Circe Mesh. */
export const speakWithCirceHost = Effect.fn("Circe.hostSpeak")(function* (
  input: CirceHostSpeakInput,
) {
  return yield* request(WS_METHODS.circeHostSpeak, input);
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
  input: CirceComputerUseInput,
) {
  return yield* request(WS_METHODS.circeComputerUse, input);
});

/** Read the node's desktop-host availability and active computer mission. */
export const getCirceComputerStatus = Effect.fn("Circe.computerStatus")(function* () {
  return yield* request(WS_METHODS.circeComputerStatus, {});
});

/**
 * Stop one running mission on its node by the request id it registered under.
 * `cancelled` is true when a live mission held the id and will halt at its next
 * step boundary; false means it had already settled.
 */
export const cancelCirceMission = Effect.fn("Circe.cancelMission")(function* (
  input: CirceCancelMissionInput,
) {
  return yield* request(WS_METHODS.circeCancelMission, input);
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
