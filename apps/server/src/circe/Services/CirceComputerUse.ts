import type { CirceComputerUseInput, CirceComputerUseResult } from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ComputerMission } from "../../computer/ComputerService.ts";
import type { DesktopOutcome } from "../host/core.ts";

/**
 * A bounded desktop computer-use mission owned by the node. It runs the
 * TypeSafe step loop over grounded accessibility elements on this machine and
 * never fails the request: every perception, decision, or input problem maps
 * to a typed result the origin interaction can speak. Confirmation is required
 * once per session before the first mission.
 */
export interface CirceComputerUseShape {
  readonly run: (input: CirceComputerUseInput) => Effect.Effect<CirceComputerUseResult>;
  /**
   * One whole goal inside a mission its owner already holds (a provider
   * session's granted mission), through the same executor as `run`. It
   * starts no mission of its own and leaves the mission to its owner.
   */
  readonly runInMission: (
    mission: ComputerMission,
    goal: CirceComputerGoal,
  ) => Effect.Effect<CirceComputerUseResult>;
  /** Whether this node carries out whole goals (circe-core installed). */
  readonly wholeGoals: boolean;
}

export interface CirceComputerGoal {
  readonly goal: string;
  /** Checked before every action: true once the requester or the user stopped the goal. */
  readonly stopped: Effect.Effect<boolean>;
  /** A plan the requester's own model already made; circe-core validates and grounds it. */
  readonly plan?: unknown;
  readonly application?: string;
  readonly typeText?: string;
  readonly onProgress?: (text: string) => void;
  /** circe-core's full outcome, timings and trace included, before it is mapped to a result. */
  readonly onFinished?: (outcome: DesktopOutcome) => void;
}

export class CirceComputerUse extends Context.Service<CirceComputerUse, CirceComputerUseShape>()(
  "@absterrg0/circe/circe/Services/CirceComputerUse",
) {}
