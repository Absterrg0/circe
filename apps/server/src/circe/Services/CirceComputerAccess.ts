import type {
  CirceComputerAccessView,
  CirceComputerOutcome,
  CirceComputerUseResult,
  CirceDeviceTarget,
  RunId,
  ThreadId,
} from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export type { CirceComputerOutcome };

/**
 * Who asked to use this computer. The user asks through Circe from one device
 * session, and Circe's own executor carries the goal out. A coding agent asks
 * through its computer tools during one run, and an approval hands a mission
 * to that exact provider session for that run only.
 */
export type CirceComputerRequester =
  | {
      readonly kind: "user";
      /** The device session that was asked; only its spoken answer settles the request. */
      readonly origin: string | null;
    }
  | {
      readonly kind: "agent";
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly providerSessionId: string;
      /** The agent's thread title, so the approval says who is asking. */
      readonly title: string;
    };

export type CirceComputerAgent = Extract<CirceComputerRequester, { readonly kind: "agent" }>;

export interface CirceComputerRequest {
  readonly id: string;
  readonly goal: string;
  readonly requester: CirceComputerRequester;
  readonly at: string;
  /** The stop id a client registered for this run, when it minted one. */
  readonly cancelId: string | null;
  /** How Circe's executor should carry the goal out, when the caller said. */
  readonly options?: {
    readonly typeText?: string;
    readonly maxSteps?: number;
  };
}

/**
 * This computer's use right now. At most one request waits for approval and
 * at most one holder uses the computer, matching the node's single computer
 * mission. Nothing here survives a restart: a pending approval is dropped
 * rather than run later, and a restart ends the native mission anyway.
 */
export interface CirceComputerAccessState {
  readonly pending: CirceComputerRequest | null;
  readonly active:
    | (CirceComputerRequest & {
        readonly startedAt: string;
        /** The native mission an agent holds; null while it is being admitted. */
        readonly missionId: string | null;
      })
    | null;
  readonly last: {
    readonly request: CirceComputerRequest;
    readonly outcome: CirceComputerOutcome;
    readonly message: string;
    readonly at: string;
  } | null;
}

/** How an agent's request stands after waiting on the user. */
export type CirceComputerGrant =
  | { readonly status: "granted"; readonly missionId: string }
  | { readonly status: "waiting"; readonly requestId: string }
  | { readonly status: "declined"; readonly message: string };

/**
 * Where a decision came from. A typed decision names the exact request the
 * client showed. A spoken one comes through Circe from one device session and
 * settles a user's request only when that session was the one asked.
 */
export type CirceComputerDecisionSource =
  | { readonly kind: "explicit" }
  | {
      readonly kind: "spoken";
      readonly origin: string | null;
      /** The request the speaking device was showing, when it said. */
      readonly presented?: string | null;
    };

/** A request this node cannot take; its message is what the user or agent is told. */
export class CirceComputerAccessError extends Schema.TaggedError<CirceComputerAccessError>()(
  "CirceComputerAccessError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/**
 * The node's one owner of this computer. Every route that wants it comes
 * here: Circe on the user's behalf, the Computer panel, the interaction
 * route, and coding agents through their computer tools. Nothing touches the
 * computer before the user approves, and a new goal replaces a waiting one
 * and needs its own approval.
 */
export interface CirceComputerAccessShape {
  /** False on a node whose preset has no desktop. */
  readonly controllable: boolean;
  readonly state: Effect.Effect<CirceComputerAccessState>;
  /** Asks to use the computer for `goal`. The request waits for `decide`. */
  readonly request: (input: {
    readonly goal: string;
    readonly requester: CirceComputerRequester;
  }) => Effect.Effect<CirceComputerRequest, CirceComputerAccessError>;
  /** Settles the waiting request with this id. */
  readonly decide: (
    requestId: string,
    decision: "approve" | "deny",
    source: CirceComputerDecisionSource,
  ) => Effect.Effect<void, CirceComputerAccessError>;
  /**
   * Runs a goal the user already approved where they asked, such as the
   * Computer panel's Run button, and waits for its result. The run belongs
   * to the node: a caller that goes away leaves it to finish and settle.
   */
  readonly run: (input: {
    readonly goal: string;
    readonly cancelId?: string;
    readonly target?: CirceDeviceTarget;
    readonly origin?: string;
    readonly typeText?: string;
    readonly maxSteps?: number;
  }) => Effect.Effect<CirceComputerUseResult>;
  /**
   * Withdraws the waiting request and stops whoever uses the computer, or
   * only the request with this id or client stop id. False when nothing
   * matched.
   */
  readonly stop: (requestId?: string) => Effect.Effect<boolean>;
  /**
   * For an agent: waits up to `timeout` for the user to settle its request,
   * or returns at once when its session already holds the computer.
   */
  readonly awaitGrant: (
    requester: CirceComputerAgent,
    requestId: string,
    timeout: Duration.Input,
  ) => Effect.Effect<CirceComputerGrant>;
  /**
   * Whether this agent run holds the computer right now. Every computer tool
   * call checks it, so a later run in the same provider session never
   * inherits an earlier run's grant; a stale hold is released on the spot.
   */
  readonly holds: (agent: {
    readonly providerSessionId: string;
    readonly runId: RunId | null;
  }) => Effect.Effect<boolean>;
  /** An agent handing the computer back. */
  readonly release: (providerSessionId: string) => Effect.Effect<void>;
  /** The state as clients see it; emits the current state first, then every change. */
  readonly view: Stream.Stream<CirceComputerAccessView>;
  /** Wakes once on subscription and then whenever the state changes, so a reader never misses one. */
  readonly changes: Stream.Stream<void>;
}

export class CirceComputerAccess extends Context.Service<
  CirceComputerAccess,
  CirceComputerAccessShape
>()("@absterrg0/circe/circe/Services/CirceComputerAccess") {}
