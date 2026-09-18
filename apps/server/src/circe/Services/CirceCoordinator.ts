import type {
  CirceCoordinateInput,
  CirceExecutionResult,
  CirceProjectContext,
  CirceProjectGoalInput,
  CirceProjectRef,
  AuthSessionId,
  EnvironmentId,
} from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CirceControllerError } from "./CirceController.ts";
import type { CirceMemoryPromotionError, CirceMemoryStoreError } from "./CirceProjectMemory.ts";

export type CirceCoordinatorError =
  | CirceControllerError
  | CirceMemoryStoreError
  | CirceMemoryPromotionError;

/**
 * The Circe-level project coordinator. It owns the project goal and the pinned
 * context written into the workspace, and it is the single seam that turns an
 * instruction into a thread turn. Workers read the pinned context as an
 * ordinary workspace file; memory bodies stay behind the provider's own file
 * tools. It is not a provider thread.
 */
export interface CirceCoordinatorShape {
  /** Read the goal and pinned context without writing anything. */
  readonly getContext: (
    projectRef: CirceProjectRef,
  ) => Effect.Effect<CirceProjectContext, CirceCoordinatorError>;
  /** Set the project goal and refresh the workspace context. */
  readonly setGoal: (
    input: CirceProjectGoalInput,
  ) => Effect.Effect<CirceProjectContext, CirceCoordinatorError>;
  /** Refresh the workspace context and route one instruction to a thread. */
  readonly coordinate: (
    input: CirceCoordinateInput & {
      readonly sessionId: AuthSessionId;
      readonly executionNodeId?: EnvironmentId | undefined;
    },
  ) => Effect.Effect<CirceExecutionResult, CirceCoordinatorError>;
  /** Record one project memory entry through the coordinator. */
  readonly remember: (input: {
    readonly projectRef: CirceProjectRef;
    readonly kind: "episode" | "fact";
    readonly source: "user" | "agent" | "system";
    readonly title: string;
    readonly body: string;
    readonly tags?: ReadonlyArray<string>;
    readonly confirmed?: boolean;
  }) => Effect.Effect<void, CirceCoordinatorError>;
}

export class CirceCoordinator extends Context.Service<CirceCoordinator, CirceCoordinatorShape>()(
  "@absterrg0/circe/circe/Services/CirceCoordinator",
) {}
