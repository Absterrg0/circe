import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  CirceMissionCancellation,
  type CirceMissionCancellationShape,
} from "../Services/CirceMissionCancellation.ts";

interface MissionState {
  readonly active: ReadonlySet<string>;
  readonly stop: ReadonlySet<string>;
}

/**
 * Registering never evicts a live entry: a mission's own `ensuring` clears its
 * id when it settles, so a fixed cap would only ever let a busy node drop the
 * stop flag of a mission that is still running.
 */
const add = (current: ReadonlySet<string>, requestId: string): ReadonlySet<string> => {
  if (current.has(requestId)) return current;
  const next = new Set(current);
  next.add(requestId);
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
      active: add(state.active, requestId),
      stop: state.stop,
    }));

  const isCancelled: CirceMissionCancellationShape["isCancelled"] = (requestId) =>
    Ref.get(ref).pipe(Effect.map((state) => state.stop.has(requestId)));

  const requestStop: CirceMissionCancellationShape["requestStop"] = (requestId) =>
    Ref.modify(ref, (state) => {
      if (!state.active.has(requestId)) return [false, state];
      return [true, { active: state.active, stop: add(state.stop, requestId) }];
    });

  const clear: CirceMissionCancellationShape["clear"] = (requestId) =>
    Ref.update(ref, (state) => ({
      active: without(state.active, requestId),
      stop: without(state.stop, requestId),
    }));

  return CirceMissionCancellation.of({ register, isCancelled, requestStop, clear });
});

export const CirceMissionCancellationLive = Layer.effect(CirceMissionCancellation, make);
