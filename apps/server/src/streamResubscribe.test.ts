import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";

import { withResubscribe } from "./streamResubscribe.ts";

it.effect("resubscribes a consumer whose stream died, catching up before each new one", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    let subscriptions = 0;
    const consumer = Effect.suspend(() => {
      subscriptions += 1;
      calls.push(`subscribe ${subscriptions}`);
      // The first two streams die; the third stays up.
      return subscriptions < 3 ? Effect.die("stream failed") : Effect.never;
    });
    const running = yield* withResubscribe<never, never, never>("Test consumer", consumer, {
      onResubscribe: Effect.sync(() => void calls.push("catch up")),
      schedule: Schedule.recurs(5),
    }).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.deepStrictEqual(calls, [
      "subscribe 1",
      "catch up",
      "subscribe 2",
      "catch up",
      "subscribe 3",
    ]);
    yield* Fiber.interrupt(running);
  }),
);
