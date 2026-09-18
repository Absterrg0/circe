import type { DesktopSnapshot } from "@circe/core/desktopSurface";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopSurface,
  DesktopSurfaceUnavailableError,
} from "../desktopSurface/Services/DesktopSurface.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { make } from "./CirceComputerUse.ts";
import { CirceMissionCancellationLive } from "./CirceMissionCancellation.ts";

const snapshot: DesktopSnapshot = {
  capture: {
    captureId: "cap_1",
    displayId: "primary",
    width: 800,
    height: 600,
    scale: 1,
    takenAtMs: 1,
    source: "semantic",
  },
  title: "Desktop",
  regions: [
    {
      id: "app:0/0/3",
      role: "push button",
      name: "Save",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      source: "semantic",
      interactive: true,
    },
  ],
};

const choose = (action: string) => ({
  status: "answered" as const,
  model: "jev-latest",
  answers: {
    action: {
      type: "choice" as const,
      choice: action,
      probabilities: { [action]: 0.95 },
      confidence: 0.95,
    },
    element: {
      type: "choice" as const,
      choice: "app:0/0/3",
      probabilities: { "app:0/0/3": 0.95 },
      confidence: 0.95,
    },
  },
});

const testLayer = (input: {
  readonly decisions: ReadonlyArray<string>;
  readonly acts: Array<string>;
  readonly observe?: () => Effect.Effect<DesktopSnapshot, DesktopSurfaceUnavailableError>;
}) => {
  let index = 0;
  return Layer.effect(CirceComputerUse, make()).pipe(
    Layer.provide(
      Layer.succeed(DesktopSurface, {
        observe: input.observe ?? (() => Effect.succeed(snapshot)),
        snapshot: () => Effect.succeed(snapshot),
        act: (action) =>
          Effect.sync(() => {
            input.acts.push(action.kind);
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(CirceDecision, {
        decide: () => {
          const action = input.decisions[Math.min(index, input.decisions.length - 1)] ?? "done";
          index += 1;
          return Effect.succeed(choose(action));
        },
      }),
    ),
    Layer.provide(CirceMissionCancellationLive),
  );
};

const run = (
  input: { readonly goal: string; readonly confirmed?: boolean },
  layer: Layer.Layer<CirceComputerUse>,
) =>
  Effect.runSync(
    Effect.gen(function* () {
      const computerUse = yield* CirceComputerUse;
      return yield* computerUse.run({
        goal: input.goal,
        ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
      });
    }).pipe(Effect.provide(layer), Effect.orDie),
  );

describe("Circe computer use", () => {
  it("requires one confirmation before the first mission", () => {
    const result = run({ goal: "save the document" }, testLayer({ decisions: [], acts: [] }));
    expect(result.status).toBe("needs-input");
  });

  it("runs observe, decide, act and reports done", () => {
    const acts: Array<string> = [];
    const result = run(
      { goal: "save the document", confirmed: true },
      testLayer({ decisions: ["click", "done"], acts }),
    );
    expect(result).toEqual({ status: "done", message: "Done: save the document", steps: 2 });
    expect(acts).toEqual(["click"]);
  });

  it("reports the surface as unavailable rather than failing the request", () => {
    const result = run(
      { goal: "save the document", confirmed: true },
      testLayer({
        decisions: ["click"],
        acts: [],
        observe: () => Effect.fail(new DesktopSurfaceUnavailableError({ reason: "no backend" })),
      }),
    );
    expect(result).toEqual({ status: "unavailable", message: "no backend" });
  });
});
