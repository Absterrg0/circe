import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Stop registry for running node missions (browser and computer use). A mission
 * registers under its client request id, the loop polls `isCancelled` at each
 * step boundary, and a stop request from any paired client flips that flag.
 * The mission clears its entry when it settles, so state is bounded by the
 * number of missions actually running.
 *
 * `requestStop` answers whether a live mission held that id: `false` means the
 * mission already finished or never started, so a stale stop never cancels a
 * later mission that reuses the id.
 */
export interface CirceMissionCancellationShape {
  /** Claim one running mission under its request id. */
  readonly register: (requestId: string) => Effect.Effect<void>;
  /** Whether a stop was requested for this mission. */
  readonly isCancelled: (requestId: string) => Effect.Effect<boolean>;
  /** Ask the live mission to stop; false when no mission holds the id. */
  readonly requestStop: (requestId: string) => Effect.Effect<boolean>;
  /** Drop all state for a settled mission. */
  readonly clear: (requestId: string) => Effect.Effect<void>;
}

export class CirceMissionCancellation extends Context.Service<
  CirceMissionCancellation,
  CirceMissionCancellationShape
>()("@absterrg0/circe/circe/Services/CirceMissionCancellation") {}
