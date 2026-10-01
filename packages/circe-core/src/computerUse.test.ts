import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildComputerStepRequest,
  buildTypeTextCandidates,
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
  it("offers only grounded elements, finite action kinds, and bounded type spans", () => {
    const request = buildComputerStepRequest({ model: "m", goal: "Open compose", surface });
    const action = request.questions["action"];
    expect(action?.type).toBe("choice");
    if (action?.type !== "choice") throw new Error("expected choice");
    expect(Object.keys(action.criteria)).toContain("type");
    // Typing has no free text: every offered span is a run of the user's words.
    const typeText = request.questions["type_text"];
    if (typeText?.type !== "choice") throw new Error("expected type_text choice");
    expect(Object.keys(typeText.criteria)).toEqual(["Open compose", "Open", "compose"]);
    const element = request.questions["element"];
    if (element?.type !== "choice") throw new Error("expected element choice");
    expect(Object.keys(element.criteria)).toEqual([
      "role=button[name='Compose']",
      "role=textbox[name='Search']",
      "none",
    ]);
  });

  it("carries a partial observation into the selector state", () => {
    const request = buildComputerStepRequest({
      model: "m",
      goal: "Open compose",
      surface: { ...surface, degraded: true },
    });
    expect((request.state as { readonly surface: unknown }).surface).toMatchObject({
      degraded: true,
    });
    const complete = buildComputerStepRequest({ model: "m", goal: "Open compose", surface });
    expect((complete.state as { readonly surface: unknown }).surface).not.toHaveProperty(
      "degraded",
    );
  });

  it("uses planned text and offers no span question when the plan supplied it", () => {
    const request = buildComputerStepRequest({
      model: "m",
      goal: "Send the note",
      surface,
      typeText: "hello",
    });
    const action = request.questions["action"];
    if (action?.type !== "choice") throw new Error("expected choice");
    expect(Object.keys(action.criteria)).toContain("type");
    expect(request.questions["type_text"]).toBeUndefined();
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

  it("refuses type when no span was chosen", () => {
    const step = composeComputerStep({
      goal: "Send the note",
      surface,
      answers: selecting(["action", choice("type")], ["element", choice("none")]),
    });
    expect(step).toEqual({ kind: "refused", reason: "missing-parameter" });
  });

  it("types the span of the user's own words that the model selected", () => {
    const step = composeComputerStep({
      goal: "open youtube and search tanmay bhat",
      surface,
      answers: selecting(
        ["action", choice("type")],
        ["element", choice("role=textbox[name='Search']")],
        ["type_text", choice("tanmay bhat")],
      ),
    });
    expect(step).toEqual({
      kind: "action",
      action: { kind: "type", elementId: "role=textbox[name='Search']", text: "tanmay bhat" },
    });
  });

  it("refuses a span the goal never contained", () => {
    const step = composeComputerStep({
      goal: "open youtube and search tanmay bhat",
      surface,
      answers: selecting(
        ["action", choice("type")],
        ["element", choice("role=textbox[name='Search']")],
        ["type_text", choice("buy crypto now")],
      ),
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

  it("presses one named key on a grounded element", () => {
    const step = composeComputerStep({
      goal: "Submit",
      surface,
      answers: selecting(
        ["action", choice("press")],
        ["element", choice("role=textbox[name='Search']")],
        ["press_key", choice("enter")],
      ),
    });
    expect(step).toEqual({
      kind: "action",
      action: { kind: "press", elementId: "role=textbox[name='Search']", key: "enter" },
    });
  });

  it("refuses a keypress with no grounded element instead of using ambient focus", () => {
    const step = composeComputerStep({
      goal: "Submit",
      surface,
      answers: selecting(
        ["action", choice("press")],
        ["element", choice("none")],
        ["press_key", choice("enter")],
      ),
    });
    expect(step).toEqual({ kind: "refused", reason: "missing-parameter" });
  });

  it("types into the observed focused element when the model chose none", () => {
    const focused: ComputerSurface = {
      ...surface,
      focusedElementId: "role=textbox[name='Search']",
    };
    const step = composeComputerStep({
      goal: "Send the note",
      surface: focused,
      typeText: "hello",
      answers: selecting(["action", choice("type")], ["element", choice("none")]),
    });
    expect(step).toEqual({
      kind: "action",
      action: { kind: "type", elementId: "role=textbox[name='Search']", text: "hello" },
    });
  });

  it("refuses type when no element is grounded and none is observed as focused", () => {
    const step = composeComputerStep({
      goal: "Send the note",
      surface,
      typeText: "hello",
      answers: selecting(["action", choice("type")], ["element", choice("none")]),
    });
    expect(step).toEqual({ kind: "refused", reason: "missing-parameter" });
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

describe("type text candidates", () => {
  it("offers the exact phrase after a search cue in a long natural sentence", () => {
    const goal = "I want you to open youtube and search for tanmay bhat in my own browser please";
    const candidates = buildTypeTextCandidates(goal);
    expect(candidates).toContain("tanmay bhat");
  });

  it("offers a quoted span exactly", () => {
    const candidates = buildTypeTextCandidates('search for "meeting notes draft" now');
    expect(candidates).toContain("meeting notes draft");
  });

  it("trims meta-words like 'phrase' from a cue span", () => {
    expect(buildTypeTextCandidates("search for the phrase circe deep test")).toContain(
      "circe deep test",
    );
  });

  it("offers a cue span when the goal ends at the phrase", () => {
    expect(buildTypeTextCandidates("open youtube and search tanmay bhat")).toContain("tanmay bhat");
  });

  it("covers every start position before the candidate cap applies", () => {
    const tokens = Array.from({ length: 12 }, (_, index) => `word${index}`);
    const candidates = buildTypeTextCandidates(tokens.join(" "));
    for (const token of tokens) expect(candidates).toContain(token);
  });
});

describe("computer use runner", () => {
  /**
   * A surface whose element identity moves on every capture, so a test that
   * targets the confirmation or recovery path is not stopped by the
   * no-effect gate.
   */
  const driftingSurface = (): (() => ComputerSurface) => {
    let captures = 0;
    return () => {
      captures += 1;
      return {
        ...surface,
        elements: [{ ...surface.elements[0]!, name: `Compose ${captures}` }, surface.elements[1]!],
      };
    };
  };

  it.effect("captures, selects, and applies until the selector reports done", () =>
    Effect.gen(function* () {
      const applied: Array<string> = [];
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("role=button[name='Compose']")]),
        selecting(["action", choice("type")], ["element", choice("role=textbox[name='Search']")]),
        selecting(["action", choice("done")]),
      ];
      // The surface moves after each applied action: a real click and a real
      // keystroke change what is observed, and the no-progress guard must not
      // fire on a fixture that never shows an effect.
      const capture = driftingSurface();
      const result = yield* runComputerUse({
        model: "m",
        goal: "Send the note",
        typeText: "hello",
        runtime: {
          capture: () => Effect.succeed(capture()),
          select: () => Effect.succeed(scripted[step++]!),
          apply: (action) =>
            Effect.sync(() => {
              applied.push(action.kind);
              return true;
            }),
        },
      });
      expect(result).toEqual({
        status: "done",
        steps: 3,
        summary: "Send the note",
        verified: true,
      });
      expect(applied).toEqual(["click", "type"]);
    }),
  );

  it.effect("tells the goal check when a click changed nothing and honors its refusal", () =>
    Effect.gen(function* () {
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("role=button[name='Compose']")]),
        selecting(["action", choice("done")]),
      ];
      const seen: Array<{
        readonly sinceStart: boolean | undefined;
        readonly afterAction: boolean | undefined;
      }> = [];
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open the compose window",
        runtime: {
          // The click changes nothing: same title, same elements, same names.
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(scripted[step++]!),
          apply: () => Effect.succeed(true),
        },
        verify: (input) =>
          Effect.sync(() => {
            seen.push({
              sinceStart: input.surfaceChangedSinceStart,
              afterAction: input.surfaceChangedAfterLastAction,
            });
            return false;
          }),
      });
      expect(result).toEqual({
        status: "unverified",
        steps: 2,
        summary: "Open the compose window",
        reason: "verification-failed",
      });
      expect(seen).toEqual([{ sinceStart: false, afterAction: false }]);
    }),
  );

  it.effect("accepts done when the click changed the observation", () =>
    Effect.gen(function* () {
      const after: ComputerSurface = {
        ...surface,
        title: "Compose",
        elements: [
          {
            id: "role=textbox[name='To']",
            role: "textbox",
            name: "To",
            bounds: { x: 10, y: 10, width: 200, height: 30 },
          },
        ],
      };
      let captured = 0;
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("role=button[name='Compose']")]),
        selecting(["action", choice("done")]),
      ];
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open the compose window",
        runtime: {
          capture: () => Effect.succeed(captured++ === 0 ? surface : after),
          select: () => Effect.succeed(scripted[step++]!),
          apply: () => Effect.succeed(true),
        },
        verify: () => Effect.succeed(true),
      });
      expect(result).toEqual({
        status: "done",
        steps: 2,
        summary: "Open the compose window",
        verified: true,
      });
    }),
  );

  it.effect("accepts done when the click changed only a field value", () =>
    Effect.gen(function* () {
      const display = {
        ...surface,
        elements: [
          {
            id: "role=text[name='Display']",
            role: "text",
            name: "Display",
            value: "0",
            bounds: { x: 10, y: 10, width: 200, height: 40 },
          },
        ],
      };
      const after = {
        ...display,
        elements: [{ ...display.elements[0]!, value: "7" }],
      };
      let captured = 0;
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("role=text[name='Display']")]),
        selecting(["action", choice("done")]),
      ];
      const result = yield* runComputerUse({
        model: "m",
        goal: "Press 7 on the keypad",
        runtime: {
          capture: () => Effect.succeed(captured++ === 0 ? display : after),
          select: () => Effect.succeed(scripted[step++]!),
          apply: () => Effect.succeed(true),
        },
        verify: () => Effect.succeed(true),
      });
      expect(result).toEqual({
        status: "done",
        steps: 2,
        summary: "Press 7 on the keypad",
        verified: true,
      });
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
          apply: () => Effect.succeed(true),
        },
      });
      expect(result).toEqual({ status: "budget-exhausted", steps: 2 });
    }),
  );

  it.effect("reports a done after only a wait as unverified", () =>
    Effect.gen(function* () {
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("wait")]),
        selecting(["action", choice("done")]),
      ];
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(scripted[step++]!),
          apply: () => Effect.succeed(true),
        },
      });
      expect(result).toEqual({
        status: "unverified",
        steps: 2,
        summary: "Open compose",
        reason: "no-effect",
      });
    }),
  );

  it.effect("does not accept done when the goal-specific check fails", () =>
    Effect.gen(function* () {
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("role=button[name='Compose']")]),
        selecting(["action", choice("done")]),
      ];
      const capture = driftingSurface();
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(capture()),
          select: () => Effect.succeed(scripted[step++]!),
          apply: () => Effect.succeed(true),
        },
        verify: () => Effect.succeed(false),
      });
      expect(result).toEqual({
        status: "unverified",
        steps: 2,
        summary: "Open compose",
        reason: "verification-failed",
      });
    }),
  );

  it.effect("does not count an unapplied action as an effect", () =>
    Effect.gen(function* () {
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("role=button[name='Compose']")]),
        selecting(["action", choice("done")]),
      ];
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(scripted[step++]!),
          apply: () => Effect.succeed(false),
        },
      });
      expect(result).toEqual({
        status: "unverified",
        steps: 2,
        summary: "Open compose",
        reason: "no-effect",
      });
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
          apply: () => Effect.succeed(true),
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
          apply: () => Effect.succeed(true),
        },
        shouldStop: () =>
          Effect.sync(() => {
            checks += 1;
            return checks >= 4;
          }),
      });
      expect(result).toEqual({ status: "cancelled", steps: 1 });
    }),
  );

  it.effect("checks stop again after selection and never mutates after it", () =>
    Effect.gen(function* () {
      let applied = 0;
      let checks = 0;
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () =>
            Effect.succeed(
              selecting(
                ["action", choice("click")],
                ["element", choice("role=button[name='Compose']")],
              ),
            ),
          apply: () =>
            Effect.sync(() => {
              applied += 1;
              return true;
            }),
        },
        shouldStop: () =>
          Effect.sync(() => {
            checks += 1;
            // Third check is the one between selection and mutation.
            return checks >= 3;
          }),
      });
      expect(result).toEqual({ status: "cancelled", steps: 0 });
      expect(applied).toBe(0);
    }),
  );

  it.effect("recovers a refusal with one grounded provider plan", () =>
    Effect.gen(function* () {
      const applied: Array<string> = [];
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("none")]),
        selecting(["action", choice("click")], ["element", choice("role=button[name='Compose']")]),
        selecting(["action", choice("done")]),
      ];
      let replans = 0;
      const capture = driftingSurface();
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(capture()),
          select: () => Effect.succeed(scripted[step++] ?? selecting(["action", choice("done")])),
          apply: (action) =>
            Effect.sync(() => {
              applied.push(action.kind === "click" ? action.elementId : action.kind);
              return true;
            }),
        },
        replan: (recovery) => {
          replans += 1;
          expect(recovery.reason).toBe("refused");
          return Effect.succeed([
            { kind: "click" as const, elementId: "role=button[name='Compose']" },
            { kind: "click" as const, elementId: "role=button[name='Ghost']" },
          ]);
        },
      });
      expect(replans).toBe(1);
      // The valid prefix is executed; the step after the invalid one is
      // rejected with it, so only the grounded Compose click is applied twice
      // (once recovered, once by the model).
      expect(applied).toEqual(["role=button[name='Compose']", "role=button[name='Compose']"]);
      expect(result).toEqual({
        status: "done",
        steps: 4,
        summary: "Open compose",
        verified: true,
      });
    }),
  );

  it.effect("does not replan twice", () =>
    Effect.gen(function* () {
      let replans = 0;
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        maxSteps: 3,
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () =>
            Effect.succeed(selecting(["action", choice("click")], ["element", choice("none")])),
          apply: () => Effect.succeed(true),
        },
        replan: () => {
          replans += 1;
          return Effect.succeed([{ kind: "wait" as const }]);
        },
      });
      expect(replans).toBe(1);
      expect(result.status).toBe("refused");
    }),
  );

  it.effect("checks stop before every recovered mutation", () =>
    Effect.gen(function* () {
      let applied = 0;
      let checks = 0;
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
              return true;
            }),
        },
        shouldStop: () =>
          Effect.sync(() => {
            checks += 1;
            // First two checks pass (pre-capture, then the refused step); the
            // third is the last gate before the recovered mutation.
            return checks >= 3;
          }),
        replan: () =>
          Effect.succeed([{ kind: "click" as const, elementId: "role=button[name='Compose']" }]),
      });
      // A stop accepted by the node is never followed by the recovered
      // mutation, and the run reports cancelled rather than refused.
      expect(applied).toBe(0);
      expect(result.status).toBe("cancelled");
    }),
  );

  it.effect("executes a semantic plan against fresh surfaces, not stale ids", () =>
    Effect.gen(function* () {
      const applied: Array<string> = [];
      const planned: Array<string> = [];
      let captures = 0;
      // Names stay stable while ids change on every observation: only
      // role/name resolution survives. Each applied action also changes the
      // observation, so the postcondition check sees the effect.
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose and search",
        runtime: {
          capture: () => {
            captures += 1;
            return Effect.succeed({
              ...surface,
              elements: [
                {
                  ...surface.elements[0]!,
                  id: `ax:button-${captures}`,
                  name: captures >= 2 ? "Compose opened" : "Compose",
                },
                {
                  ...surface.elements[1]!,
                  id: `ax:field-${captures}`,
                  ...(captures >= 3 ? { value: "hello" } : {}),
                },
              ],
            });
          },
          select: () => Effect.die("the model must not run while a plan is active"),
          apply: (action) =>
            Effect.sync(() => {
              applied.push(action.kind);
              return true;
            }),
        },
        plan: (input) => {
          planned.push(input.reason);
          return Effect.succeed([
            {
              intent: "open compose",
              action: "click",
              targetRole: "button",
              targetName: "Compose",
            },
            {
              intent: "search",
              action: "type",
              targetRole: "textbox",
              targetName: "Search",
              text: "hello",
            },
          ]);
        },
        verify: () => Effect.succeed(true),
      });
      expect(planned).toEqual(["start"]);
      expect(applied).toEqual(["click", "type"]);
      expect(result.status).toBe("done");
    }),
  );

  it.effect("replans when a planned control is missing from the fresh surface", () =>
    Effect.gen(function* () {
      const applied: Array<string> = [];
      const reasons: Array<string> = [];
      let plans = 0;
      const result = yield* runComputerUse({
        model: "m",
        goal: "Send the note",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(selecting(["action", choice("done")])),
          apply: (action) =>
            Effect.sync(() => {
              applied.push(action.kind);
              return true;
            }),
        },
        plan: (input) => {
          reasons.push(input.reason);
          plans += 1;
          if (plans === 1) {
            return Effect.succeed([
              { intent: "save", action: "click", targetRole: "button", targetName: "Ghost" },
            ]);
          }
          return Effect.succeed([
            { intent: "save", action: "click", targetRole: "button", targetName: "Compose" },
          ]);
        },
        verify: () => Effect.succeed(false),
      });
      expect(reasons).toEqual(["start", "target-missing"]);
      expect(applied).toEqual(["click"]);
      expect(result.status).toBe("unverified");
    }),
  );

  it.effect("stops after two applied actions changed nothing", () =>
    Effect.gen(function* () {
      let selects = 0;
      const result = yield* runComputerUse({
        model: "m",
        goal: "Open compose",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => {
            selects += 1;
            return Effect.succeed(
              selecting(
                ["action", choice("click")],
                ["element", choice("role=button[name='Compose']")],
              ),
            );
          },
          apply: () => Effect.succeed(true),
        },
      });
      expect(result.status).toBe("unverified");
      if (result.status !== "unverified") return;
      expect(result.reason).toBe("no-progress");
      // Two no-op clicks are enough; the loop never asks for a third.
      expect(selects).toBe(2);
    }),
  );

  it.effect("rejects a recovery plan whose first prerequisite is invalid", () =>
    Effect.gen(function* () {
      const applied: Array<string> = [];
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("none")]),
        // After the rejected plan the model still gets a chance.
        selecting(["action", choice("done")]),
      ];
      const result = yield* runComputerUse({
        model: "m",
        goal: "Save the document",
        runtime: {
          capture: () => Effect.succeed(surface),
          select: () => Effect.succeed(scripted[step++] ?? selecting(["action", choice("done")])),
          apply: (action) =>
            Effect.sync(() => {
              applied.push(action.kind);
              return true;
            }),
        },
        replan: () =>
          Effect.succeed([
            // The field does not exist, so "click Save" is not executable.
            { kind: "type" as const, elementId: "role=textbox[name='Title']", text: "Report" },
            { kind: "click" as const, elementId: "role=button[name='Compose']" },
          ]),
      });
      // The unusable plan is rejected whole: neither the missing-field step
      // nor the dependent Save click runs.
      expect(applied).toEqual([]);
      expect(result.status).toBe("refused");
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
              return true;
            }),
        },
      });
      expect(result).toEqual({ status: "refused", reason: "missing-parameter", steps: 1 });
      expect(applied).toBe(0);
    }),
  );
});

describe("visual candidates", () => {
  const visualSurface: ComputerSurface = {
    kind: "desktop",
    title: "Canvas",
    elements: [
      {
        id: "visual:text-3",
        source: "visual",
        role: "text",
        name: "Send",
        bounds: { x: 378, y: 274, width: 31, height: 17 },
      },
    ],
  };

  it("offers visual regions as click-only and never as key or text targets", () => {
    const request = buildComputerStepRequest({
      model: "m",
      goal: "send it",
      surface: visualSurface,
    });
    const element = request.questions.element as { criteria: Record<string, string> };
    expect(element.criteria["visual:text-3"]).toContain("seen on screen, click only");
    for (const action of ["type", "press"] as const) {
      const step = composeComputerStep({
        goal: 'type "hi"',
        surface: visualSurface,
        answers: selecting(
          ["action", choice(action)],
          ["element", choice("visual:text-3")],
          ["type_text", choice("hi")],
          ["press_key", choice("enter")],
        ),
      });
      expect(step).toEqual({ kind: "refused", reason: "unsupported-target" });
    }
    expect(
      composeComputerStep({
        goal: "send it",
        surface: visualSurface,
        answers: selecting(["action", choice("click")], ["element", choice("visual:text-3")]),
      }),
    ).toEqual({ kind: "action", action: { kind: "click", elementId: "visual:text-3" } });
  });

  it.effect("looks closer once when the model cannot ground a step", () =>
    Effect.gen(function* () {
      let escalations = 0;
      const offered: Array<ReadonlyArray<string>> = [];
      const applied: Array<string> = [];
      const result = yield* runComputerUse({
        model: "m",
        goal: "send it",
        maxSteps: 1,
        runtime: {
          capture: () => Effect.succeed({ kind: "desktop", title: "Canvas", elements: [] }),
          escalate: () =>
            Effect.sync(() => {
              escalations += 1;
              return visualSurface;
            }),
          select: (request) =>
            Effect.sync(() => {
              const element = request.questions.element as
                | { criteria: Record<string, string> }
                | undefined;
              offered.push(Object.keys(element?.criteria ?? {}));
              return element === undefined
                ? selecting(["action", choice("click")])
                : selecting(["action", choice("click")], ["element", choice("visual:text-3")]);
            }),
          apply: (action) =>
            Effect.sync(() => {
              if (action.kind === "click") applied.push(action.elementId);
              return true;
            }),
        },
      });
      expect(escalations).toBe(1);
      expect(offered).toEqual([[], ["visual:text-3", "none"]]);
      expect(applied).toEqual(["visual:text-3"]);
      expect(result.status).toBe("budget-exhausted");
    }),
  );
});
