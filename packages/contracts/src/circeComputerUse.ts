import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CirceBrowserUseInput, CirceBrowserUseResult } from "./circeBrowserUse.ts";

/**
 * A desktop computer-use mission. It has the same bounded shape as a browser
 * mission: a goal, optional planned text, a step cap, a once-per-session
 * confirmation, and a typed result. The surface differs (the OS desktop
 * instead of a browser tab) but the origin client treats them the same way.
 */
export const CirceComputerUseInput = CirceBrowserUseInput;
export type CirceComputerUseInput = typeof CirceComputerUseInput.Type;

export const CirceComputerUseResult = CirceBrowserUseResult;
export type CirceComputerUseResult = typeof CirceComputerUseResult.Type;

/**
 * Live status for the node's computer-use capability. Clients render the
 * mission state and only offer a start affordance when the desktop host is
 * connected; the server never infers availability client-side.
 */
export const CirceComputerMission = Schema.Struct({
  id: TrimmedNonEmptyString,
  goal: Schema.String.check(Schema.isMaxLength(1_000)),
  startedAtMs: Schema.Number,
  /** The client request id the mission registered for cancellation. */
  requestId: Schema.optional(TrimmedNonEmptyString),
});
export type CirceComputerMission = typeof CirceComputerMission.Type;

export const CirceComputerStatusInput = Schema.Struct({});
export type CirceComputerStatusInput = typeof CirceComputerStatusInput.Type;

export const CirceComputerStatus = Schema.Struct({
  available: Schema.Boolean,
  platform: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  activeMission: Schema.optional(CirceComputerMission),
});
export type CirceComputerStatus = typeof CirceComputerStatus.Type;
