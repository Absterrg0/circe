import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { CirceMissionCancellationShape } from "../Services/CirceMissionCancellation.ts";
import { make } from "./CirceMissionCancellation.ts";

const withRegistry = <A>(run: (registry: CirceMissionCancellationShape) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    const registry = yield* make;
    return yield* run(registry);
  });

describe("mission cancellation registry", () => {
  it("ignores a stop for an id no mission holds", () => {
    const result = Effect.runSync(
      withRegistry((registry) =>
        Effect.gen(function* () {
          const cancelled = yield* registry.requestStop("mission-1");
          const flagged = yield* registry.isCancelled("mission-1");
          return { cancelled, flagged };
        }),
      ),
    );
    expect(result).toEqual({ cancelled: false, flagged: false });
  });

  it("flags a registered mission and stops it once", () => {
    const result = Effect.runSync(
      withRegistry((registry) =>
        Effect.gen(function* () {
          yield* registry.register("mission-2");
          const cancelled = yield* registry.requestStop("mission-2");
          const flagged = yield* registry.isCancelled("mission-2");
          return { cancelled, flagged };
        }),
      ),
    );
    expect(result).toEqual({ cancelled: true, flagged: true });
  });

  it("clears all state when a mission settles", () => {
    const result = Effect.runSync(
      withRegistry((registry) =>
        Effect.gen(function* () {
          yield* registry.register("mission-3");
          yield* registry.requestStop("mission-3");
          yield* registry.clear("mission-3");
          const flagged = yield* registry.isCancelled("mission-3");
          const cancelled = yield* registry.requestStop("mission-3");
          return { flagged, cancelled };
        }),
      ),
    );
    expect(result).toEqual({ flagged: false, cancelled: false });
  });

  it("tracks each mission independently", () => {
    const result = Effect.runSync(
      withRegistry((registry) =>
        Effect.gen(function* () {
          yield* registry.register("mission-a");
          yield* registry.register("mission-b");
          yield* registry.requestStop("mission-a");
          return {
            a: yield* registry.isCancelled("mission-a"),
            b: yield* registry.isCancelled("mission-b"),
          };
        }),
      ),
    );
    expect(result).toEqual({ a: true, b: false });
  });
});
