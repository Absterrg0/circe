import type {
  ComputerPlanInput,
  ComputerPlanStep,
  ComputerRecoveryInput,
  ComputerRecoveryStep,
} from "@circe/core/computerUse";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

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
}

export class CirceRecoveryPlanner extends Context.Service<
  CirceRecoveryPlanner,
  CirceRecoveryPlannerShape
>()("@absterrg0/circe/circe/Services/CirceRecoveryPlanner") {}
