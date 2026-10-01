import type {
  ComputerPlanInput,
  ComputerPlanStep,
  ComputerRecoveryInput,
  ComputerRecoveryStep,
} from "@circe/core/computerUse";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Bounded recovery planning through the ordinary provider registry. It is
 * optional: a node with no configured supervisor simply returns no plan, and
 * the mission reports its stall honestly.
 */
export interface CirceRecoveryPlannerShape {
  readonly plan: (
    input: ComputerRecoveryInput,
  ) => Effect.Effect<ReadonlyArray<ComputerRecoveryStep>>;
  /**
   * One short semantic plan: steps name controls by role and name, and the
   * host resolves each against a fresh surface when it becomes eligible.
   */
  readonly planGoal: (input: ComputerPlanInput) => Effect.Effect<ReadonlyArray<ComputerPlanStep>>;
  /**
   * circe-core's desktop planner: its prompt goes to the node's planning
   * model and the structured answer comes back unvalidated, since circe-core
   * reads and grounds every step itself. Fails when no model answers.
   */
  readonly planDesktop: (prompt: string) => Effect.Effect<unknown, CirceDesktopPlanUnavailable>;
}

/** No planning model answered: none is configured, it failed, or it timed out. */
export class CirceDesktopPlanUnavailable extends Schema.TaggedError<CirceDesktopPlanUnavailable>()(
  "CirceDesktopPlanUnavailable",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class CirceRecoveryPlanner extends Context.Service<
  CirceRecoveryPlanner,
  CirceRecoveryPlannerShape
>()("@absterrg0/circe/circe/Services/CirceRecoveryPlanner") {}
