import type { PreviewAutomationElement } from "@circe/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { BrowserAutomationOperation } from "./browserUse.ts";
import { runBrowserGoal, type BrowserAutomationInvoker } from "./browserUseRuntime.ts";
import type { DecisionAnswer, DecisionAnswers } from "./decision.ts";

const element = (
  selector: string,
  role: string | null,
  name: string,
): PreviewAutomationElement => ({
  tag: "button",
  role,
  name,
  selector,
  x: 1,
  y: 2,
  width: 30,
  height: 12,
});

const snapshot = {
  title: "Inbox",
  url: "https://mail.example.com",
  visibleText: "Compose",
  interactiveElements: [element("role=button[name='Compose']", "button", "Compose")],
};

const choice = (value: string, confidence = 0.95): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const selecting = (...entries: ReadonlyArray<readonly [string, DecisionAnswer]>): DecisionAnswers =>
  Object.fromEntries(entries);

describe("browser use runtime", () => {
  it.effect("captures a grounded surface and applies selector-targeted operations", () =>
    Effect.gen(function* () {
      const operations: Array<BrowserAutomationOperation> = [];
      let step = 0;
      const scripted: ReadonlyArray<DecisionAnswers> = [
        selecting(["action", choice("click")], ["element", choice("role=button[name='Compose']")]),
        selecting(["action", choice("done")]),
      ];
      const invoker: BrowserAutomationInvoker = {
        snapshot: () => Effect.succeed(snapshot),
        apply: (operation) =>
          Effect.sync(() => {
            operations.push(operation);
          }),
      };
      const result = yield* runBrowserGoal({
        model: "m",
        goal: "Open compose",
        invoker,
        select: () => Effect.succeed(scripted[step++]!),
      });
      expect(result).toEqual({ status: "done", steps: 2, summary: "Open compose" });
      expect(operations).toEqual([
        { operation: "click", input: { locator: "role=button[name='Compose']" } },
      ]);
    }),
  );

  it.effect("uses the invoker settle hook for a wait action instead of an operation", () =>
    Effect.gen(function* () {
      let waited = 0;
      const operations: Array<BrowserAutomationOperation> = [];
      const result = yield* runBrowserGoal({
        model: "m",
        goal: "Let it settle",
        maxSteps: 2,
        invoker: {
          snapshot: () => Effect.succeed(snapshot),
          apply: (operation) =>
            Effect.sync(() => {
              operations.push(operation);
            }),
          wait: () =>
            Effect.sync(() => {
              waited += 1;
            }),
        },
        select: () => Effect.succeed(selecting(["action", choice("wait")])),
      });
      expect(result).toEqual({ status: "budget-exhausted", steps: 2 });
      expect(operations).toEqual([]);
      expect(waited).toBe(2);
    }),
  );
});
