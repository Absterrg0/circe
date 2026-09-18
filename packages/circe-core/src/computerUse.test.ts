import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildComputerStepRequest,
  composeComputerStep,
  runComputerUse,
  type ComputerSurface,
} from "./computerUse.ts";
import type { DecisionAnswer, DecisionAnswers } from "./decision.ts";

const surface: ComputerSurface = {
  kind: "browser",
  title: "Inbox",
  url: "https://mail.example.com",
  visibleText: "Compose",
  elements: [
    {
      id: "role=button[name='Compose']",
      role: "button",
      name: "Compose",
      bounds: { x: 10, y: 10, width: 100, height: 30 },
    },
    {
      id: "role=textbox[name='Search']",
      role: "textbox",
      name: "Search",
      bounds: { x: 10, y: 50, width: 200, height: 30 },
    },
  ],
};

const choice = (value: string, confidence = 0.95): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const selecting = (...entries: ReadonlyArray<readonly [string, DecisionAnswer]>): DecisionAnswers =>
  Object.fromEntries(entries);

describe("computer step request", () => {
  it("offers only grounded elements and finite action kinds", () => {
    const request = buildComputerStepRequest({ model: "m", goal: "Open compose", surface });
    const action = request.questions["action"];
    expect(action?.type).toBe("choice");
    if (action?.type !== "choice") throw new Error("expected choice");
    // Without planned text there is nothing for the model to invent.
    expect(Object.keys(action.criteria)).not.toContain("type");
    const element = request.questions["element"];
    if (element?.type !== "choice") throw new Error("expected element choice");
    expect(Object.keys(element.criteria)).toEqual([
      "role=button[name='Compose']",
      "role=textbox[name='Search']",
      "none",
    ]);
  });

  it("enables the type action only when the plan supplied text", () => {
    const request = buildComputerStepRequest({
      model: "m",
      goal: "Send the note",
      surface,
      typeText: "hello",
    });
    const action = request.questions["action"];
    if (action?.type !== "choice") throw new Error("expected choice");
    expect(Object.keys(action.criteria)).toContain("type");
  });
});

describe("computer step composition", () => {
  it("derives a click on a grounded element", () => {
    const step = composeComputerStep({
      goal: "Open compose",
      surface,
      answers: selecting(
        ["action", choice("click")],
        ["element", choice("role=button[name='Compose']")],
      ),
    });
    expect(step).toEqual({
      kind: "action",
      action: { kind: "click", elementId: "role=button[name='Compose']" },
    });
  });

  it("refuses a selected element that is not on the surface", () => {
    const step = composeComputerStep({
      goal: "Open compose",
      surface,
      answers: selecting(
        ["action", choice("click")],
        ["element", choice("role=button[name='Ghost']")],
      ),
    });
    expect(step).toEqual({ kind: "refused", reason: "unknown-element" });
  });

  it("refuses a click with no element", () => {
    const step = composeComputerStep({
      goal: "Open compose",
      surface,
      answers: selecting(["action", choice("click")], ["element", choice("none")]),
    });
    expect(step).toEqual({ kind: "refused", reason: "missing-parameter" });
  });

  it("refuses type when no planned text exists", () => {
    const step = composeComputerStep({
      goal: "Send the note",
      surface,
      answers: selecting(["action", choice("type")], ["element", choice("none")]),
    });
    expect(step).toEqual({ kind: "refused", reason: "missing-parameter" });
  });

  it("types planned text into a grounded element", () => {
    const step = composeComputerStep({
      goal: "Send the note",
      surface,
      typeText: "hello",
      answers: selecting(
        ["action", choice("type")],
        ["element", choice("role=textbox[name='Search']")],
      ),
    });
    expect(step).toEqual({
      kind: "action",
      action: { kind: "type", elementId: "role=textbox[name='Search']", text: "hello" },
    });
  });

  it("presses one named key", () => {
    const step = composeComputerStep({
      goal: "Submit",
      surface,
      answers: selecting(
        ["action", choice("press")],
        ["element", choice("none")],
        ["press_key", choice("enter")],
      ),
    });
    expect(step).toEqual({ kind: "action", action: { kind: "press", key: "enter" } });
  });

  it("refuses low confidence instead of guessing", () => {
    const step = composeComputerStep({
      goal: "Open compose",
      surface,
      answers: selecting(["action", choice("click", 0.2)]),
    });
    expect(step).toEqual({ kind: "refused", reason: "confidence-too-low" });
  });

  it("reports done with no action", () => {
    const step = composeComputerStep({
      goal: "Open compose",
      surface,
      answers: selecting(["action", choice("done")]),
    });
    expect(step).toEqual({ kind: "done", summary: "Open compose" });
  });
});

describe("computer use runner", () => {
  it.effect("captures, selects, and applies until the selector reports done", () =>
    Effect.gen(function* () {
      const applied: Array<string> = [];
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("role=button[name='Compose']")]),
        selecting(["action", choice("type")], ["element", choice("none")]),
        selecting(["action", choice("done")]),
      ];
      const result = yield* runComputerUse({
        model: "m",
        goal: "Send the note",
        typeText: "hello",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(scripted[step++]!),
          apply: (action) =>
            Effect.sync(() => {
              applied.push(action.kind);
            }),
        },
      });
      expect(result).toEqual({ status: "done", steps: 3, summary: "Send the note" });
      expect(applied).toEqual(["click", "type"]);
    }),
  );

  it.effect("stops at the step budget without claiming success", () =>
    Effect.gen(function* () {
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        maxSteps: 2,
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(selecting(["action", choice("wait")])),
          apply: () => Effect.void,
        },
      });
      expect(result).toEqual({ status: "budget-exhausted", steps: 2 });
    }),
  );

  it.effect("reports a done with no applied action as unverified", () =>
    Effect.gen(function* () {
      let applied = 0;
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(selecting(["action", choice("done")])),
          apply: () =>
            Effect.sync(() => {
              applied += 1;
            }),
        },
      });
      expect(result).toEqual({ status: "unverified", steps: 1, summary: "Open compose" });
      expect(applied).toBe(0);
    }),
  );

  it.effect("refuses an element outside the offered slice", () =>
    Effect.gen(function* () {
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        maxElements: 1,
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () =>
            Effect.succeed(
              selecting(
                ["action", choice("click")],
                ["element", choice("role=textbox[name='Search']")],
              ),
            ),
          apply: () => Effect.void,
        },
      });
      // Only the first element was offered, so the second is unknown.
      expect(result).toEqual({ status: "refused", reason: "unknown-element", steps: 1 });
    }),
  );

  it.effect("stops between steps when shouldStop reports stop", () =>
    Effect.gen(function* () {
      let checks = 0;
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(selecting(["action", choice("wait")])),
          apply: () => Effect.void,
        },
        shouldStop: () =>
          Effect.sync(() => {
            checks += 1;
            return checks >= 2;
          }),
      });
      expect(result).toEqual({ status: "cancelled", steps: 1 });
    }),
  );

  it.effect("returns a refusal from composition without applying it", () =>
    Effect.gen(function* () {
      let applied = 0;
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () =>
            Effect.succeed(selecting(["action", choice("click")], ["element", choice("none")])),
          apply: () =>
            Effect.sync(() => {
              applied += 1;
            }),
        },
      });
      expect(result).toEqual({ status: "refused", reason: "missing-parameter", steps: 1 });
      expect(applied).toBe(0);
    }),
  );
});
