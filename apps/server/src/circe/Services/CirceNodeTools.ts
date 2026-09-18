import type { CirceNodeToolExecutors } from "@circe/core/controlDispatch";
import * as Context from "effect/Context";

/**
 * The node-side executors for bounded read-only tools. A tool is offered to
 * the classifier only when it appears in `available`, so a missing executor is
 * a wiring failure rather than something the user is told about.
 */
export interface CirceNodeToolsShape {
  readonly available: ReadonlyArray<string>;
  readonly executors: CirceNodeToolExecutors;
}

export class CirceNodeTools extends Context.Service<CirceNodeTools, CirceNodeToolsShape>()(
  "@absterrg0/circe/circe/Services/CirceNodeTools",
) {}
