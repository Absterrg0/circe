import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { DesktopCommands } from "../desktopUse/DesktopCommands.ts";
import { DesktopUse } from "../desktopUse/DesktopUse.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { make } from "./CirceComputerUse.ts";

const dump = JSON.stringify({
  elements: [
    {
      id: "app:0/0/3",
      role: "push button",
      name: "Save",
      bounds: { x: 700, y: 40, width: 80, height: 24 },
      editable: false,
      actions: ["click"],
    },
  ],
});

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
  readonly operations: Array<string>;
}) => {
  let index = 0;
  return Layer.effect(CirceComputerUse, make({ backend: "linux-x11" })).pipe(
    Layer.provide(
      Layer.mock(DesktopUse)({
        input: (request) =>
          Effect.sync(() => {
            input.operations.push(request.action.type);
            return {};
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(DesktopCommands)({
        run: (_command, _backend, operation) =>
          Effect.succeed({
            stdout: operation === "desktop.accessibility" ? dump : JSON.stringify({ ok: true }),
            stderr: "",
            code: 0,
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(CirceDecision)({
        decide: () => {
          const action = input.decisions[Math.min(index, input.decisions.length - 1)] ?? "done";
          index += 1;
          return Effect.succeed(choose(action));
        },
      }),
    ),
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
    }).pipe(Effect.provide(layer)),
  );

describe("Circe computer use", () => {
  it("requires one confirmation before the first mission", () => {
    const result = run(
      { goal: "save the document" },
      testLayer({ decisions: ["done"], operations: [] }),
    );
    expect(result).toEqual({
      status: "needs-input",
      message: "I'll control this computer in this session to save the document. Confirm to start.",
    });
  });

  it("activates a grounded element through AT-SPI and reports done", () => {
    const operations: Array<string> = [];
    const result = run(
      { goal: "save the document", confirmed: true },
      testLayer({ decisions: ["click", "done"], operations }),
    );
    expect(result).toEqual({ status: "done", message: "Done: save the document", steps: 2 });
    expect(operations).toEqual([]);
  });
});
