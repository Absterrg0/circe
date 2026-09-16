import type { CirceDecisionOutcome, DecisionAnswer, DecisionRequest } from "../decision.ts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { decideWithSelfConsistency } from "./selfConsistency.ts";

const request: DecisionRequest = {
  state: { utterance: "stop authentication" },
  model: "jev-latest",
  questions: {
    action: {
      type: "choice",
      instructions: "Which action?",
      criteria: { stop: null, start: null },
    },
  },
};

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const answered = (value: string, model = "jev-test"): CirceDecisionOutcome => ({
  status: "answered",
  model,
  answers: { action: choice(value) },
});

const sequenceDecide = (
  outcomes: ReadonlyArray<CirceDecisionOutcome>,
): ((request: DecisionRequest) => Effect.Effect<CirceDecisionOutcome>) => {
  let index = 0;
  return () => {
    const outcome = outcomes[Math.min(index, outcomes.length - 1)]!;
    index += 1;
    return Effect.succeed(outcome);
  };
};

describe("self-consistency experiment", () => {
  it("accepts when both runs agree", () =>
    Effect.gen(function* () {
      const result = yield* decideWithSelfConsistency({
        request,
        watch: ["action"],
        decide: sequenceDecide([answered("stop"), answered("stop")]),
      });
      expect(result.status).toBe("agree");
    }).pipe(Effect.runPromise));

  it("turns model variance into a disagreement instead of a wrong dispatch", () =>
    Effect.gen(function* () {
      const result = yield* decideWithSelfConsistency({
        request,
        watch: ["action"],
        decide: sequenceDecide([answered("stop"), answered("start")]),
      });
      expect(result).toEqual({
        status: "disagree",
        questionId: "action",
        first: "stop",
        second: "start",
      });
    }).pipe(Effect.runPromise));

  it("propagates a decline from either run", () =>
    Effect.gen(function* () {
      const result = yield* decideWithSelfConsistency({
        request,
        watch: ["action"],
        decide: sequenceDecide([
          { status: "decline", reason: "decision-timeout" },
          answered("stop"),
        ]),
      });
      expect(result).toEqual({ status: "decline", reason: "decision-timeout" });
    }).pipe(Effect.runPromise));
});
