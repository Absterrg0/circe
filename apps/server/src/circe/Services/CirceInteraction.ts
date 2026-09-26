import type {
  AuthSessionId,
  CirceDeviceReadiness,
  CirceInteractionError,
  CirceInteractionId,
  CirceInteractionInterruptInput,
  CirceInteractionInterruptResult,
  CirceInteractionState,
  CirceInteractionSubmitInput,
  CirceInteractionSubmitResult,
  EnvironmentId,
} from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/**
 * The node-owned assistant interaction. One durable record owns the current
 * goal, the pending question, and the active operation. Every client submits
 * typed input here and renders the returned state; device selection,
 * clarification routing, and completion rules stay behind this interface.
 */
export interface CirceInteractionShape {
  readonly submit: (
    input: CirceInteractionSubmitInput & {
      readonly executionNodeId: EnvironmentId;
      /** The authenticated session whose task desk the stop updates. */
      readonly sessionId?: AuthSessionId;
    },
  ) => Effect.Effect<CirceInteractionSubmitResult, CirceInteractionError>;
  readonly read: (input: {
    readonly executionNodeId: EnvironmentId;
    readonly interactionId?: CirceInteractionId;
  }) => Effect.Effect<CirceInteractionState | null, CirceInteractionError>;
  /**
   * Stop the active operation or pending question. Stop is not queued behind
   * input, and it distinguishes a requested stop from a confirmed one.
   */
  readonly interrupt: (
    input: CirceInteractionInterruptInput & { readonly executionNodeId: EnvironmentId },
  ) => Effect.Effect<CirceInteractionInterruptResult, CirceInteractionError>;
  /** Live state changes for one interaction; reconnect reads state instead. */
  readonly subscribe: (input: {
    readonly interactionId?: CirceInteractionId | undefined;
  }) => Stream.Stream<CirceInteractionState>;
  /** Observed desktop readiness for this node, not a policy promise. */
  readonly readiness: () => Effect.Effect<CirceDeviceReadiness, CirceInteractionError>;
}

export class CirceInteraction extends Context.Service<CirceInteraction, CirceInteractionShape>()(
  "@absterrg0/circe/circe/Services/CirceInteraction",
) {}
