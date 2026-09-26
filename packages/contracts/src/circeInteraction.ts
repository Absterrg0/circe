import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CirceClientToolCandidates,
  CirceClientToolName,
  CirceInterpretEvidenceNode,
  CirceInterpretEvidenceProject,
  CirceInterpretEvidenceProvider,
  CirceInterpretEvidenceTask,
  CirceNodeId,
  CirceOriginMetadata,
  CirceSemanticProposal,
} from "./circe.ts";

const makeInteractionId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

/**
 * The durable assistant interaction: one server-owned conversation that owns
 * the current goal, the pending question, the bound device target, and the
 * active operation. Clients submit typed input and render the resulting state;
 * they never decide locally what an answer resumes.
 *
 * The revision is the single ordering authority. A submission names the
 * revision it answered, so two devices answering the same question cannot both
 * consume it.
 */
export const CirceInteractionId = makeInteractionId("CirceInteractionId");
export type CirceInteractionId = typeof CirceInteractionId.Type;

export const CirceOperationId = makeInteractionId("CirceOperationId");
export type CirceOperationId = typeof CirceOperationId.Type;

export const CirceInteractionGoalKind = Schema.Literals([
  "lookup",
  "device",
  "coding",
  "conversation",
]);
export type CirceInteractionGoalKind = typeof CirceInteractionGoalKind.Type;

export const CirceLookupTool = Schema.Literals(["weather", "time"]);
export type CirceLookupTool = typeof CirceLookupTool.Type;

export const CirceLookupDay = Schema.Literals(["now", "today", "tomorrow"]);
export type CirceLookupDay = typeof CirceLookupDay.Type;

/**
 * What the interaction is trying to do. A lookup carries its resolved
 * arguments; a device goal carries the user's own instruction verbatim, never
 * a rewritten prompt.
 */
export const CirceInteractionGoal = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("lookup"),
    tool: CirceLookupTool,
    day: CirceLookupDay,
    location: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  }),
  Schema.Struct({
    kind: Schema.Literal("device"),
    surface: Schema.Literals(["browser", "preview", "computer"]),
    goal: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({ kind: Schema.Literal("coding") }),
  Schema.Struct({ kind: Schema.Literal("conversation") }),
]);
export type CirceInteractionGoal = typeof CirceInteractionGoal.Type;

export const CirceInteractionQuestionKind = Schema.Literals(["argument", "choice", "approval"]);
export type CirceInteractionQuestionKind = typeof CirceInteractionQuestionKind.Type;

/**
 * A question exists before Circe asks it aloud. The slot names what is missing,
 * `known` carries the arguments already resolved (never internal ids), and the
 * owner is the interaction's node.
 */
export const CirceInteractionQuestion = Schema.Struct({
  questionId: TrimmedNonEmptyString,
  kind: CirceInteractionQuestionKind,
  slot: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  known: Schema.Record(Schema.String, Schema.String),
  choices: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(160))).check(
    Schema.isMaxLength(8),
  ),
});
export type CirceInteractionQuestion = typeof CirceInteractionQuestion.Type;

/** How an input relates to the interaction it was submitted against. */
export const CirceInputRelation = Schema.Literals([
  "answer",
  "correction",
  "new-request",
  "cancel",
]);
export type CirceInputRelation = typeof CirceInputRelation.Type;

export const CirceInteractionOutcomeStatus = Schema.Literals([
  "answered",
  "completed",
  "needs-input",
  "unavailable",
  "failed",
  "stopped",
  "outcome-unknown",
]);
export type CirceInteractionOutcomeStatus = typeof CirceInteractionOutcomeStatus.Type;

export const CirceInteractionOutcome = Schema.Struct({
  status: CirceInteractionOutcomeStatus,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  source: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
});
export type CirceInteractionOutcome = typeof CirceInteractionOutcome.Type;

export const CirceDeviceSurface = Schema.Literals(["browser", "preview", "computer", "native-app"]);
export type CirceDeviceSurface = typeof CirceDeviceSurface.Type;

/**
 * A qualified physical target: node plus the desktop session generation and
 * the application. A tab id is session-scoped and never survives a reconnect.
 */
export const CirceDeviceTarget = Schema.Struct({
  nodeId: CirceNodeId,
  surface: CirceDeviceSurface,
  desktopSessionId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  sessionGeneration: Schema.optional(NonNegativeInt),
  application: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  profile: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  windowId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  tabId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
});
export type CirceDeviceTarget = typeof CirceDeviceTarget.Type;

export const CirceInteractionState = Schema.Struct({
  interactionId: CirceInteractionId,
  ownerNodeId: CirceNodeId,
  revision: NonNegativeInt,
  goal: CirceInteractionGoal,
  pending: Schema.NullOr(CirceInteractionQuestion),
  target: Schema.NullOr(CirceDeviceTarget),
  operationId: Schema.NullOr(CirceOperationId),
  outcome: Schema.NullOr(CirceInteractionOutcome),
  updatedAt: Schema.DateTimeUtcFromString,
});
export type CirceInteractionState = typeof CirceInteractionState.Type;

export const CirceOperationScope = Schema.Literals(["observe", "input", "navigate", "launch"]);
export type CirceOperationScope = typeof CirceOperationScope.Type;

export const CirceOperationStatus = Schema.Literals([
  "accepted",
  "running",
  "verifying",
  "completed",
  "stopped",
  "blocked",
  "needs-input",
  "outcome-unknown",
]);
export type CirceOperationStatus = typeof CirceOperationStatus.Type;

/** The observed effect of one applied step. Uncertainty stays explicit. */
export const CirceOperationResult = Schema.Literals([
  "applied",
  "not-applied",
  "unknown",
  "blocked",
]);
export type CirceOperationResult = typeof CirceOperationResult.Type;

/**
 * One accepted device operation. Acceptance is persisted before execution, so
 * a lost response can be resolved by inspecting existing state rather than
 * retrying an effect that may already have landed.
 */
export const CirceOperation = Schema.Struct({
  operationId: CirceOperationId,
  ownerNodeId: CirceNodeId,
  interactionId: CirceInteractionId,
  interactionRevision: NonNegativeInt,
  target: CirceDeviceTarget,
  authorizedScope: Schema.Array(CirceOperationScope).check(Schema.isMaxLength(8)),
  goal: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  expectedOutcome: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  status: CirceOperationStatus,
  steps: NonNegativeInt,
  lastResult: Schema.NullOr(CirceOperationResult),
  verification: Schema.NullOr(
    Schema.Struct({
      checked: Schema.Boolean,
      detail: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
    }),
  ),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type CirceOperation = typeof CirceOperation.Type;

/** Observed readiness, not a policy promise. Clients only act on ready surfaces. */
export const CirceDeviceSurfaceReadiness = Schema.Struct({
  surface: CirceDeviceSurface,
  ready: Schema.Boolean,
  reason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
  profiles: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(160))).check(
    Schema.isMaxLength(16),
  ),
  applications: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(160))).check(
    Schema.isMaxLength(64),
  ),
});
export type CirceDeviceSurfaceReadiness = typeof CirceDeviceSurfaceReadiness.Type;

export const CirceDeviceReadiness = Schema.Struct({
  nodeId: CirceNodeId,
  preset: Schema.Literals(["full", "controller", "headless"]),
  controlAllowed: Schema.Boolean,
  adapterSupported: Schema.Boolean,
  sessionActive: Schema.Boolean,
  permissionGranted: Schema.Boolean,
  surfaces: Schema.Array(CirceDeviceSurfaceReadiness).check(Schema.isMaxLength(8)),
  detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
});
export type CirceDeviceReadiness = typeof CirceDeviceReadiness.Type;

/**
 * Bounded catalogs the client already holds, passed as untrusted evidence for
 * one classification. Names only; the node revalidates every ref it later
 * authorizes. The client never uses this evidence to route the turn itself.
 */
export const CirceInteractionEvidence = Schema.Struct({
  projects: Schema.Array(CirceInterpretEvidenceProject).check(Schema.isMaxLength(64)),
  tasks: Schema.Array(CirceInterpretEvidenceTask).check(Schema.isMaxLength(32)),
  providers: Schema.Array(CirceInterpretEvidenceProvider).check(Schema.isMaxLength(32)),
  nodes: Schema.optional(Schema.Array(CirceInterpretEvidenceNode).check(Schema.isMaxLength(32))),
  currentProjectTitle: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  ),
  focusedTask: Schema.optional(
    Schema.Struct({
      title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
      project: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240))),
    }),
  ),
  continueContext: Schema.optional(Schema.Boolean),
  clientTools: Schema.optional(Schema.Array(CirceClientToolName).check(Schema.isMaxLength(16))),
  clientToolCandidates: Schema.optional(CirceClientToolCandidates),
});
export type CirceInteractionEvidence = typeof CirceInteractionEvidence.Type;

export const CirceInteractionSubmitInput = Schema.Struct({
  utterance: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
  /** The interaction the input continues; absent means the node's active one. */
  interactionId: Schema.optional(CirceInteractionId),
  /** The revision the user saw when answering. Mismatch is a stale answer. */
  expectedRevision: Schema.optional(NonNegativeInt),
  /** Client-generated identity. Replaying the same requestId is idempotent. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  origin: Schema.optional(CirceOriginMetadata),
  /** Qualified node the user asked for; the server still verifies readiness. */
  preferredNodeId: Schema.optional(CirceNodeId),
  /** Explicit removable preference such as a browser profile label. */
  preferredProfile: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  sourceUtterance: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(16_000))),
  /** Bounded catalogs for one classification; never routing authority. */
  evidence: Schema.optional(CirceInteractionEvidence),
});
export type CirceInteractionSubmitInput = typeof CirceInteractionSubmitInput.Type;

/**
 * Result of one submission. `delegated` means the server resolved the turn to
 * ordinary project work and returns the grounded proposal the client should
 * execute; the client does not re-classify it.
 */
export const CirceInteractionSubmitResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("answered"),
    state: CirceInteractionState,
    message: TrimmedNonEmptyString,
    source: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({ status: Schema.Literal("question"), state: CirceInteractionState }),
  Schema.Struct({
    status: Schema.Literal("delegated"),
    state: CirceInteractionState,
    proposal: CirceSemanticProposal,
  }),
  Schema.Struct({
    status: Schema.Literal("operation"),
    state: CirceInteractionState,
    operation: CirceOperation,
  }),
  Schema.Struct({ status: Schema.Literal("stale"), state: CirceInteractionState }),
  Schema.Struct({ status: Schema.Literal("cancelled"), state: CirceInteractionState }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    state: CirceInteractionState,
    message: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    state: CirceInteractionState,
    message: TrimmedNonEmptyString,
  }),
]);
export type CirceInteractionSubmitResult = typeof CirceInteractionSubmitResult.Type;

export const CirceInteractionReadInput = Schema.Struct({
  interactionId: Schema.optional(CirceInteractionId),
});
export type CirceInteractionReadInput = typeof CirceInteractionReadInput.Type;

export const CirceInteractionReadResult = Schema.NullOr(CirceInteractionState);
export type CirceInteractionReadResult = typeof CirceInteractionReadResult.Type;

export const CirceInteractionInterruptInput = Schema.Struct({
  interactionId: CirceInteractionId,
  expectedRevision: Schema.optional(NonNegativeInt),
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
});
export type CirceInteractionInterruptInput = typeof CirceInteractionInterruptInput.Type;

/**
 * `stopConfirmed` is only true when the executing node accepted the stop.
 * A requested stop against an unreachable owner stays unconfirmed.
 */
export const CirceInteractionInterruptResult = Schema.Struct({
  stopRequested: Schema.Boolean,
  stopConfirmed: Schema.Boolean,
  state: CirceInteractionState,
});
export type CirceInteractionInterruptResult = typeof CirceInteractionInterruptResult.Type;

export const CirceInteractionSubscriptionInput = Schema.Struct({
  interactionId: Schema.optional(CirceInteractionId),
});
export type CirceInteractionSubscriptionInput = typeof CirceInteractionSubscriptionInput.Type;

export const CirceDeviceReadinessInput = Schema.Struct({});
export type CirceDeviceReadinessInput = typeof CirceDeviceReadinessInput.Type;

export const CirceInteractionErrorCode = Schema.Literals([
  "not-found",
  "node-mismatch",
  "execution-unavailable",
  "dispatch-failed",
]);
export type CirceInteractionErrorCode = typeof CirceInteractionErrorCode.Type;

export class CirceInteractionError extends Schema.TaggedError<CirceInteractionError>()(
  "CirceInteractionError",
  {
    code: CirceInteractionErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
