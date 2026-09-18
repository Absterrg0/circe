import type { CirceComputerUseInput, CirceComputerUseResult } from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * A bounded desktop computer-use mission owned by the node. It runs the
 * TypeSafe step loop over grounded accessibility elements on this machine and
 * never fails the request: every perception, decision, or input problem maps
 * to a typed result the origin interaction can speak. Confirmation is required
 * once per session before the first mission.
 */
export interface CirceComputerUseShape {
  readonly run: (input: CirceComputerUseInput) => Effect.Effect<CirceComputerUseResult>;
}

export class CirceComputerUse extends Context.Service<CirceComputerUse, CirceComputerUseShape>()(
  "@absterrg0/circe/circe/Services/CirceComputerUse",
) {}
