import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CirceRequestMetadata } from "./circe.ts";

/**
 * A bounded, project-free browser mission. The node runs the TypeSafe step
 * loop against its connected desktop browser host: perception is a grounded
 * snapshot, each action is a grounded selector, and the goal never authorizes
 * anything by itself.
 *
 * `confirmed` is a client assertion, not an authorization: the node trusts a
 * paired, operate-scoped client to have obtained the user's consent, and
 * stores no confirmation state. It exists so the origin client can prompt once
 * per session. A node that needs a hard gate must add a typed pending frame.
 */
export const CirceBrowserUseInput = Schema.Struct({
  goal: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  /**
   * Provider- or plan-supplied text for type actions. The step selector
   * chooses where and when to type it, never what to type.
   */
  typeText: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  maxSteps: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(40)),
  ),
  /** False or absent asks for the once-per-session confirmation. */
  confirmed: Schema.optional(Schema.Boolean),
  /** Original utterance for diagnostics and provenance; never dispatched. */
  sourceUtterance: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16_000))),
  /** Request identity for pre-accept cancellation and retry idempotency. */
  requestMetadata: Schema.optional(CirceRequestMetadata),
});
export type CirceBrowserUseInput = typeof CirceBrowserUseInput.Type;

export const CirceBrowserUseResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("done"),
    message: TrimmedNonEmptyString,
    steps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    status: Schema.Literal("budget"),
    message: TrimmedNonEmptyString,
    steps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  /** The user stopped the mission; it ran this many steps and then halted. */
  Schema.Struct({
    status: Schema.Literal("cancelled"),
    message: TrimmedNonEmptyString,
    steps: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  /** The step layer refused, e.g. nothing groundable or a low-confidence pick. */
  Schema.Struct({ status: Schema.Literal("refused"), message: TrimmedNonEmptyString }),
  /** Starting needs confirmation, or the model asked a question. */
  Schema.Struct({ status: Schema.Literal("needs-input"), message: TrimmedNonEmptyString }),
  /** No desktop browser host is connected to this node. */
  Schema.Struct({ status: Schema.Literal("unavailable"), message: TrimmedNonEmptyString }),
]);
export type CirceBrowserUseResult = typeof CirceBrowserUseResult.Type;
