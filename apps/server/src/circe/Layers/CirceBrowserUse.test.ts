import { EnvironmentId, type PreviewAutomationSnapshot } from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceBrowserUse } from "../Services/CirceBrowserUse.ts";
import { make } from "./CirceBrowserUse.ts";

const snapshot: PreviewAutomationSnapshot = {
  url: "https://mail.example.com",
  title: "Inbox",
  loading: false,
  visibleText: "Compose",
  interactiveElements: [
    {
      tag: "button",
      role: "button",
      name: "Compose",
      selector: "role=button[name='Compose']",
      x: 1,
      y: 2,
      width: 30,
      height: 12,
    },
  ],
  accessibilityTree: null,
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: { mimeType: "image/png", data: "", width: 100, height: 100 },
};

const choose = (choice: string) => ({
  status: "answered" as const,
  model: "jev-latest",
  answers: {
    action: {
      type: "choice" as const,
      choice,
      probabilities: { [choice]: 0.95 },
      confidence: 0.95,
    },
    element: {
      type: "choice" as const,
      choice: "role=button[name='Compose']",
      probabilities: { "role=button[name='Compose']": 0.95 },
      confidence: 0.95,
    },
  },
});

const testLayer = (input: {
  readonly decisions: ReadonlyArray<string>;
  readonly operations: Array<string>;
}) => {
  let index = 0;
  const invoke = <A>(request: { readonly operation: string }): Effect.Effect<A> => {
    input.operations.push(request.operation);
    return Effect.succeed((request.operation === "snapshot" ? snapshot : undefined) as A);
  };
  return Layer.effect(CirceBrowserUse, make).pipe(
    Layer.provide(Layer.mock(PreviewAutomationBroker)({ invoke })),
    Layer.provide(
      Layer.mock(CirceDecision)({
        decide: () => {
          const choice = input.decisions[Math.min(index, input.decisions.length - 1)] ?? "done";
          index += 1;
          return Effect.succeed(choose(choice));
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("node-1")),
      }),
    ),
  );
};

const run = (
  input: { readonly goal: string; readonly confirmed?: boolean },
  layer: Layer.Layer<CirceBrowserUse>,
) =>
  Effect.runSync(
    Effect.gen(function* () {
      const browserUse = yield* CirceBrowserUse;
      return yield* browserUse.run({
        goal: input.goal,
        ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
      });
    }).pipe(Effect.provide(layer)),
  );

describe("Circe browser use", () => {
  it("requires one confirmation before the first mission", () => {
    const result = run(
      { goal: "open the docs" },
      testLayer({ decisions: ["done"], operations: [] }),
    );
    expect(result).toEqual({
      status: "needs-input",
      message: "I'll control the browser in this session to open the docs. Confirm to start.",
    });
  });

  it("runs one grounded click and reports done once confirmed", () => {
    const operations: Array<string> = [];
    const result = run(
      { goal: "open the docs", confirmed: true },
      testLayer({ decisions: ["click", "done"], operations }),
    );
    expect(result).toEqual({ status: "done", message: "Done: open the docs", steps: 2 });
    expect(operations).toEqual(["snapshot", "click", "snapshot"]);
  });
});
