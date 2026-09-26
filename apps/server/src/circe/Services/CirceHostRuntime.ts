import type {
  CirceHostListenInput,
  CirceHostListenResult,
  CirceHostNotice,
  CirceHostSayInput,
  CirceHostSayResult,
  CirceHostSpeakInput,
  CirceHostSpeakResult,
} from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/**
 * The Circe host layer on this node: one Circe that reads the node's projects
 * and threads, carries messages out through ordinary orchestration commands,
 * and speaks up on its own when an agent needs the user. Notices are live
 * only; a client that reconnects asks instead of hearing old news.
 */
export interface CirceHostRuntimeShape {
  readonly say: (input: CirceHostSayInput) => Effect.Effect<CirceHostSayResult>;
  /** A spoken message: transcribed through Circe Mesh, then handled like `say`. */
  readonly listen: (input: CirceHostListenInput) => Effect.Effect<CirceHostListenResult>;
  /** A reply as speech; empty audio when the node cannot speak. */
  readonly speak: (input: CirceHostSpeakInput) => Effect.Effect<CirceHostSpeakResult>;
  readonly notices: Stream.Stream<CirceHostNotice>;
}

export class CirceHostRuntime extends Context.Service<CirceHostRuntime, CirceHostRuntimeShape>()(
  "@absterrg0/circe/circe/Services/CirceHostRuntime",
) {}
