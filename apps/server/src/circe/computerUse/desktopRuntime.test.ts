import type { ComputerElement, ComputerSurface } from "@circe/core/computerUse";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { makeDesktopUseRuntime } from "./desktopRuntime.ts";

const element: ComputerElement = {
  id: "snapshot:1",
  role: "push button",
  name: "Save",
  bounds: { x: 10, y: 20, width: 30, height: 30 },
};

const surface = (): ComputerSurface => ({
  kind: "desktop",
  title: "Window",
  elements: [element],
});

describe("makeDesktopUseRuntime", () => {
  it.effect("dispatches one exact click and never retries after a failure", () =>
    Effect.gen(function* () {
      const clicks = yield* Ref.make(0);
      const runtime = makeDesktopUseRuntime({
        observe: () => Effect.succeed(surface()),
        select: () =>
          Effect.succeed({
            action: { type: "choice", choice: "click", probabilities: {}, confidence: 1 },
            element: { type: "choice", choice: element.id, probabilities: {}, confidence: 1 },
          }),
        actuator: {
          click: () => Ref.update(clicks, (count) => count + 1).pipe(Effect.as(true)),
          typeInto: () => Effect.succeed(true),
          pressKey: () => Effect.void,
          typeText: () => Effect.void,
          scroll: () => Effect.void,
        },
      });
      const captured = yield* runtime.capture();
      const applied = yield* runtime.apply(
        { kind: "click", elementId: element.id },
        captured.observationRef === undefined ? {} : { observationRef: captured.observationRef },
      );
      expect(applied).toBe(true);
      expect(yield* Ref.get(clicks)).toBe(1);
    }),
  );

  it.effect("does not fall back to a second action when the actuator fails", () =>
    Effect.gen(function* () {
      const actions = yield* Ref.make(0);
      const runtime = makeDesktopUseRuntime({
        observe: () => Effect.succeed(surface()),
        select: () => Effect.die("unused"),
        actuator: {
          click: () =>
            Ref.update(actions, (count) => count + 1).pipe(
              Effect.andThen(Effect.fail("click failed")),
            ),
          typeInto: () => Effect.succeed(true),
          pressKey: () => Effect.void,
          typeText: () => Ref.update(actions, (count) => count + 1).pipe(Effect.asVoid),
          scroll: () => Effect.void,
        },
      });
      const captured = yield* runtime.capture();
      const result = yield* Effect.result(
        runtime.apply(
          { kind: "click", elementId: element.id },
          captured.observationRef === undefined ? {} : { observationRef: captured.observationRef },
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(yield* Ref.get(actions)).toBe(1);
    }),
  );

  it.effect("types into the grounded element exactly once", () =>
    Effect.gen(function* () {
      const typed = yield* Ref.make<ReadonlyArray<string>>([]);
      const runtime = makeDesktopUseRuntime({
        observe: () => Effect.succeed(surface()),
        select: () => Effect.die("unused"),
        actuator: {
          click: () => Effect.succeed(true),
          typeInto: (_element, text) =>
            Ref.update(typed, (entries) => [...entries, text]).pipe(Effect.as(true)),
          pressKey: () => Effect.void,
          typeText: () => Effect.die("untargeted typing must not run"),
          scroll: () => Effect.void,
        },
      });
      const captured = yield* runtime.capture();
      yield* runtime.apply(
        { kind: "type", elementId: element.id, text: "hello" },
        captured.observationRef === undefined ? {} : { observationRef: captured.observationRef },
      );
      expect(yield* Ref.get(typed)).toEqual(["hello"]);
    }),
  );

  it.effect("refuses a stale observation reference", () =>
    Effect.gen(function* () {
      const clicks = yield* Ref.make(0);
      const runtime = makeDesktopUseRuntime({
        observe: () => Effect.succeed(surface()),
        select: () => Effect.die("unused"),
        actuator: {
          click: () => Ref.update(clicks, (count) => count + 1).pipe(Effect.as(true)),
          typeInto: () => Effect.succeed(true),
          pressKey: () => Effect.void,
          typeText: () => Effect.void,
          scroll: () => Effect.void,
        },
      });
      yield* runtime.capture();
      yield* runtime.capture();
      const applied = yield* runtime.apply(
        { kind: "click", elementId: element.id },
        { observationRef: "observation-1" },
      );
      expect(applied).toBe(false);
      expect(yield* Ref.get(clicks)).toBe(0);
    }),
  );
});
