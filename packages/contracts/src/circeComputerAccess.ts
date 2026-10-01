import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Who uses a node's computer, and who is waiting to. The node owns one
 * request waiting for the user's approval and one holder at a time; every
 * client renders this state and settles it with the typed operations below,
 * so an approval never depends on hearing a spoken notice, and a reconnecting
 * or second device sees exactly what the node is waiting on.
 */

/** Who asked. An agent is named by its thread, never by its provider session. */
export const CirceComputerRequesterView = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("agent"),
    threadId: ThreadId,
    title: Schema.String.check(Schema.isMaxLength(300)),
  }),
]);
export type CirceComputerRequesterView = typeof CirceComputerRequesterView.Type;

export const CirceComputerRequestView = Schema.Struct({
  id: TrimmedNonEmptyString,
  goal: Schema.String.check(Schema.isMaxLength(1_000)),
  requester: CirceComputerRequesterView,
  at: Schema.String,
});
export type CirceComputerRequestView = typeof CirceComputerRequestView.Type;

export const CirceComputerOutcome = Schema.Literals([
  "completed",
  "failed",
  "uncertain",
  "stopped",
  "declined",
  "released",
]);
export type CirceComputerOutcome = typeof CirceComputerOutcome.Type;

export const CirceComputerAccessView = Schema.Struct({
  /** False on a node whose preset has no desktop; nothing else is meaningful then. */
  controllable: Schema.Boolean,
  /** Whether the node's desktop host is connected and can act now; `reason` says why not. */
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  /** A limit on an otherwise usable computer, such as unreadable custom-drawn apps. */
  limitation: Schema.optional(Schema.String),
  pending: Schema.NullOr(CirceComputerRequestView),
  active: Schema.NullOr(
    Schema.Struct({
      ...CirceComputerRequestView.fields,
      startedAt: Schema.String,
    }),
  ),
  last: Schema.NullOr(
    Schema.Struct({
      request: CirceComputerRequestView,
      outcome: CirceComputerOutcome,
      message: Schema.String,
      at: Schema.String,
    }),
  ),
});
export type CirceComputerAccessView = typeof CirceComputerAccessView.Type;

export const CirceComputerAccessSubscribeInput = Schema.Struct({});
export type CirceComputerAccessSubscribeInput = typeof CirceComputerAccessSubscribeInput.Type;

/** Settles exactly the request the client showed; a replaced request is stale. */
export const CirceComputerAccessDecideInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  decision: Schema.Literals(["approve", "deny"]),
});
export type CirceComputerAccessDecideInput = typeof CirceComputerAccessDecideInput.Type;

export const CirceComputerAccessDecideResult = Schema.Struct({
  status: Schema.Literals(["settled", "stale", "failed"]),
  message: Schema.String,
});
export type CirceComputerAccessDecideResult = typeof CirceComputerAccessDecideResult.Type;

/** Stops the named request, waiting or running; without an id, whatever uses the computer. */
export const CirceComputerAccessStopInput = Schema.Struct({
  requestId: Schema.optional(TrimmedNonEmptyString),
});
export type CirceComputerAccessStopInput = typeof CirceComputerAccessStopInput.Type;

export const CirceComputerAccessStopResult = Schema.Struct({
  /** False when the request had already settled or never existed. */
  stopped: Schema.Boolean,
});
export type CirceComputerAccessStopResult = typeof CirceComputerAccessStopResult.Type;
