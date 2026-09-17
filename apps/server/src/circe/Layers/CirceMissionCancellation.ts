import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  CirceMissionCancellation,
  type CirceMissionCancellationShape,
} from "../Services/CirceMissionCancellation.ts";

/**
 * Bounds the registry so a client that never settles a mission cannot grow it
 * without limit. The cap is far above the handful of missions a node runs at
 * once, so eviction only ever drops an abandoned entry.
 */
const REGISTRY_LIMIT = 128;

interface MissionState {
  readonly active: ReadonlySet<string>;
  readonly stop: ReadonlySet<string>;
}

const boundedAdd = (current: ReadonlySet<string>, requestId: string): ReadonlySet<string> => {
  if (current.has(requestId)) return current;
  const next = new Set(current);
  next.add(requestId);
  while (next.size > REGISTRY_LIMIT) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
};

const without = (current: ReadonlySet<string>, requestId: string): ReadonlySet<string> => {
  if (!current.has(requestId)) return current;
  const next = new Set(current);
  next.delete(requestId);
  return next;
};

export const make: Effect.Effect<CirceMissionCancellationShape> = Effect.gen(function* () {
  const ref = yield* Ref.make<MissionState>({ active: new Set(), stop: new Set() });

  const register: CirceMissionCancellationShape["register"] = (requestId) =>
    Ref.update(ref, (state) => ({
      active: boundedAdd(state.active, requestId),
      stop: state.stop,
    }));

  const isCancelled: CirceMissionCancellationShape["isCancelled"] = (requestId) =>
    Ref.get(ref).pipe(Effect.map((state) => state.stop.has(requestId)));

  const requestStop: CirceMissionCancellationShape["requestStop"] = (requestId) =>
    Ref.modify(ref, (state) => {
      if (!state.active.has(requestId)) return [false, state];
      return [true, { active: state.active, stop: boundedAdd(state.stop, requestId) }];
    });

  const clear: CirceMissionCancellationShape["clear"] = (requestId) =>
    Ref.update(ref, (state) => ({
      active: without(state.active, requestId),
      stop: without(state.stop, requestId),
    }));

  return CirceMissionCancellation.of({ register, isCancelled, requestStop, clear });
});

export const CirceMissionCancellationLive = Layer.effect(CirceMissionCancellation, make);
