import type { CirceBrowserUseInput, CirceBrowserUseResult } from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * A bounded browser mission owned by the node. It runs the TypeSafe step loop
 * against this node's connected desktop browser host and never fails the
 * request: every broker or decision problem maps to a typed result the origin
 * interaction can speak. Confirmation is required once per session before the
 * first mission.
 */
export interface CirceBrowserUseShape {
  readonly run: (input: CirceBrowserUseInput) => Effect.Effect<CirceBrowserUseResult>;
}

export class CirceBrowserUse extends Context.Service<CirceBrowserUse, CirceBrowserUseShape>()(
  "@absterrg0/circe/circe/Services/CirceBrowserUse",
) {}
