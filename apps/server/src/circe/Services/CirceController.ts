import {
  ProjectId,
  type AuthSessionId,
  type ServerSettingsError,
  type EnvironmentId,
  type CirceCancelRequestInput,
  type CirceCancelRequestResult,
  type CirceClientToolCandidates,
  type CirceClientToolName,
  type CirceExpectedReply,
  type CirceInterpretInput,
  type CirceInterpretResult,
  type CirceNeedsInputReason,
  type CirceRequestMetadata,
  type CirceSemanticProposal,
  type CirceTaskRef,
  type ModelSelection,
  type ThreadId,
  type TurnId,
} from "@circe/contracts";
import type { CirceOutcome } from "@circe/core/controlOutcome";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OrchestratorV2Error } from "../../orchestration-v2/Orchestrator.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type {
  CirceCommandContext,
  CirceCommandInterpretation,
  CirceCommandNeedsInput,
} from "@circe/core/command";

export type CirceExecutionStarted = {
  readonly status: "started";
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId;
  readonly objective: string;
  readonly modelSelection: ModelSelection;
  /** Validated supervisor copy for immediate spoken feedback; never dispatched as task input. */
  readonly acknowledgement?: string;
  readonly taskRef?: CirceTaskRef;
  readonly requestMetadata?: CirceRequestMetadata;
  /**
   * Accepted-turn correlation for speech: the turn carrying the ack when
   * known (continuations answering a pending request or steering live work).
   * Absent for brand-new tasks whose first turn has no id yet.
   */
  readonly turnId?: TurnId;
};

export type CirceExecutionAcknowledged =
  | {
      readonly status: "acknowledged";
      readonly action: "steered" | "queued" | "interrupted" | "status";
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly message: string;
    }
  | {
      readonly status: "acknowledged";
      readonly action: "focused";
      readonly projectId: ProjectId;
      readonly message: string;
    }
  | {
      readonly status: "acknowledged";
      readonly action: "projects-listed";
      readonly message: string;
    }
  | {
      readonly status: "acknowledged";
      readonly action: "conversed";
      readonly message: string;
    };

/** One validated, executed step of a multi-command turn. */
export type CirceExecutionPlanStep = {
  readonly action: string;
  readonly status: "started" | "acknowledged" | "needs-input" | "failed";
  readonly message: string;
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
};

/**
 * A multi-command turn. Every step was validated before the first dispatch,
 * so this reports an ordered, already-decided plan; a step that needed input
 * stops the plan there. Structurally matches the wire contract.
 */
export type CirceExecutionPlan = {
  readonly status: "plan";
  readonly message: string;
  readonly steps: ReadonlyArray<CirceExecutionPlanStep>;
};

/** A bounded node tool ran and its grounded result is the turn outcome. */
export type CirceExecutionToolAnswer = {
  readonly status: "tool-answer";
  readonly tool: string;
  readonly speech: string;
};

/** A bounded action the origin client performs, with revalidated arguments. */
export type CirceExecutionClientAction = {
  readonly status: "client-action";
  readonly tool: string;
  readonly args: Readonly<Record<string, string | boolean>>;
  readonly speech: string;
  readonly requestId?: string;
};

export type CirceExecutionResult =
  | CirceExecutionStarted
  | CirceExecutionAcknowledged
  | CirceExecutionToolAnswer
  | CirceExecutionClientAction
  | CirceExecutionPlan
  | CirceCommandNeedsInput
  | { readonly status: "cancelled"; readonly requestId: string };

/**
 * One classified turn: exactly one `CirceOutcome` plus the host's detailed
 * interpretation. The outcome names the dispatch branch (work, tool-answer,
 * client-action, clarification, conversation, refused); the interpretation
 * keeps the existing Director's rich routing and pending frames so nothing
 * about clarification and work authority is weakened by the new shape.
 */
export interface CirceClassifiedTurn {
  readonly outcome: CirceOutcome;
  readonly interpretation: CirceCommandInterpretation;
}

/**
 * The proposal-only result of one semantic inference. A refinement is a
 * bounded action the classifier chose but could not ground; the node turns it
 * into a durable pending frame before returning it to the client.
 */
export type CirceProposedInterpretation =
  | { readonly status: "proposal"; readonly proposal: CirceSemanticProposal }
  | {
      readonly status: "refinement";
      readonly kind: "lookup" | "website";
      readonly reason: CirceNeedsInputReason;
      readonly prompt: string;
      readonly candidates: ReadonlyArray<string>;
      readonly lookupKind?: "weather" | "time";
      readonly day?: "now" | "today" | "tomorrow";
    };

export interface CirceControllerInterpreterShape {
  readonly interpret: (input: CirceCommandContext) => Effect.Effect<CirceCommandInterpretation>;
  /**
   * The single classifier. Runs one TypeSafe decision over the offered
   * outcomes and composes exactly one `CirceOutcome`, alongside the
   * interpretation the dispatcher already understands.
   */
  readonly classify: (input: CirceCommandContext) => Effect.Effect<CirceClassifiedTurn>;
  /**
   * One proposal-only inference over untrusted mesh evidence. No dispatch,
   * no IDs, no acknowledgement: returns the typed proposal for client
   * grounding. The execution node revalidates before anything dispatches.
   * Optional in tests; production always provides it.
   */
  readonly propose?: (input: CirceInterpretInput) => Effect.Effect<CirceProposedInterpretation>;
}

/**
 * The controller receives one semantic proposal and one deterministic
 * validation pass per turn. Keeping that boundary behind a small service
 * makes the model call replaceable in tests without adding mutable state.
 */
export class CirceControllerInterpreter extends Context.Service<
  CirceControllerInterpreter,
  CirceControllerInterpreterShape
>()("@absterrg0/circe/circe/Services/CirceController/CirceControllerInterpreter") {}

export class CirceProjectNotFoundError extends Schema.TaggedError<CirceProjectNotFoundError>()(
  "CirceProjectNotFoundError",
  {
    projectId: ProjectId,
  },
) {}

/**
 * A request id is an idempotency key, not a reusable task name. Rejecting a
 * changed payload keeps a retry from returning a new objective for the old
 * receipt-backed task.
 */
export class CirceRequestConflictError extends Schema.TaggedError<CirceRequestConflictError>()(
  "CirceRequestConflictError",
  {
    requestId: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Circe request '${this.requestId}' was already used with a different payload: ${this.detail}`;
  }
}

export type CirceControllerError =
  | CirceProjectNotFoundError
  | CirceRequestConflictError
  | ProjectionRepositoryError
  | OrchestratorV2Error
  | ServerSettingsError;

export interface CirceControllerExecuteInput {
  /** Authenticated session whose compact task context is updated by the controller. */
  readonly sessionId: AuthSessionId;
  readonly utterance: string;
  /**
   * Verbatim source the proposal cites. When a proposal is supplied this is
   * the span authority (no trim); otherwise the host derives it from
   * `utterance` as before. Direct local callers omit both and run one local
   * interpretation.
   */
  readonly sourceUtterance?: string | undefined;
  /**
   * Nonauthoritative proposal from one interpret call. Schema-validated then
   * revalidated against the authoritative catalog, tasks, providers, and
   * pins; never authorizes beyond a regular user execute and never triggers
   * a second inference.
   */
  readonly semanticProposal?: CirceSemanticProposal | undefined;
  readonly projectId: ProjectId;
  readonly contextThreadId?: ThreadId | undefined;
  /** Last task known to the requesting surface; used only as a control reference. */
  readonly referenceThreadId?: ThreadId | undefined;
  /** Continue the selected conversation regardless of the wording of the utterance. */
  readonly continueContext?: boolean | undefined;
  /** Client tools the origin device can execute, advertised on the execute wire. */
  readonly clientTools?: ReadonlyArray<CirceClientToolName> | undefined;
  /** Client-owned bounded candidate sets for app and media tool parameters. */
  readonly clientToolCandidates?: CirceClientToolCandidates | undefined;
  /** A saved provider/model/options selection from the controlling client. */
  readonly modelSelection?: ModelSelection | undefined;
  /** Host-confirmed real project identity used to resume a durable clarification. */
  readonly confirmedProjectId?: ProjectId | undefined;
  /** Host-confirmed task identity used to resume a durable plan step. Internal only. */
  readonly confirmedTaskId?: ThreadId | undefined;
  /**
   * Client-pinned pending request this utterance answers, verified against
   * live state. Null pins an explicit snapshot of no unique pending request.
   */
  readonly expectedReply?: CirceExpectedReply | null | undefined;
  /** Binds an answer to the exact clarification frame it replies to. */
  readonly clarificationFrameId?: string | undefined;
  /** Internal only: transcription persisted after a real confirmation is consumed. */
  readonly confirmedProjectAlias?: string | undefined;
  /** Stable execution node supplied by the authenticated HTTP/WS boundary. */
  readonly executionNodeId?: EnvironmentId | undefined;
  /** Client request and origin metadata carried into durable task activity. */
  readonly requestMetadata?: CirceRequestMetadata | undefined;
  /** Auth-session-scoped request key used for deterministic command IDs. */
  readonly acceptanceKey?: string | undefined;
}

export interface CirceControllerShape {
  readonly execute: (
    input: CirceControllerExecuteInput,
  ) => Effect.Effect<CirceExecutionResult, CirceControllerError>;
  /**
   * One proposal-only inference over untrusted mesh evidence. No dispatch.
   * Uses the node's ordinary configured supervisor via the ordinary provider
   * registry. A clarification refinement is stored as a durable frame when a
   * session is supplied; a bound answer resumes that frame deterministically.
   */
  readonly interpret: (
    input: CirceInterpretInput & {
      readonly sessionId?: AuthSessionId | undefined;
      readonly executionNodeId?: EnvironmentId | undefined;
      readonly acceptanceKey?: string | undefined;
    },
  ) => Effect.Effect<CirceInterpretResult, CirceControllerError>;
  /**
   * Project-free conversation. Answers are best-effort and not
   * receipt-backed: retries ask the model again. Carries the same
   * pre-accept identity as control calls so cancellation addresses the
   * exact tracked interpretation; untracked when absent.
   */
  readonly converse: (input: {
    readonly utterance: string;
    readonly requestMetadata?: CirceRequestMetadata;
    readonly executionNodeId?: EnvironmentId;
    readonly acceptanceKey?: string | undefined;
  }) => Effect.Effect<CirceExecutionResult, CirceControllerError>;
  /**
   * Abort one pre-accept execute call by its exact request identity.
   * Cancelled means the interpretation never dispatched provider work;
   * already-accepted means interpretation won and the work runs under the
   * returned identity; unknown means nothing cancellable is known.
   */
  readonly cancelRequest: (
    input: CirceCancelRequestInput & { readonly executionNodeId?: EnvironmentId },
  ) => Effect.Effect<CirceCancelRequestResult, never>;
}

export class CirceController extends Context.Service<CirceController, CirceControllerShape>()(
  "@absterrg0/circe/circe/Services/CirceController",
) {}
