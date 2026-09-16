import {
  choiceAnswer,
  type CirceDecisionOutcome,
  type DecisionAnswers,
  type DecisionRequest,
} from "../decision.ts";
import * as Effect from "effect/Effect";

/**
 * Experiment: self-consistency as a cheap second look. System One answers
 * vary across runs, so asking the same high-stakes question twice and
 * requiring agreement turns model variance into a Clarify instead of a wrong
 * dispatch. Costs two requests, so it is a candidate only for destructive or
 * otherwise irreversible turns.
 */

export type ConsistencyOutcome =
  | { readonly status: "agree"; readonly model: string; readonly answers: DecisionAnswers }
  | {
      readonly status: "disagree";
      readonly questionId: string;
      readonly first: string;
      readonly second: string;
    }
  | { readonly status: "decline"; readonly reason: string };

export function arbitrateChoice(
  first: DecisionAnswers,
  second: DecisionAnswers,
  questionId: string,
):
  | { readonly status: "agree"; readonly choice: string }
  | { readonly status: "disagree"; readonly first: string; readonly second: string }
  | undefined {
  const left = choiceAnswer(first, questionId);
  const right = choiceAnswer(second, questionId);
  if (left === undefined || right === undefined) return undefined;
  if (left.choice === right.choice) return { status: "agree", choice: left.choice };
  return { status: "disagree", first: left.choice, second: right.choice };
}

/**
 * Run one decision request twice and accept only when the watched questions
 * agree. A missing or declining answer propagates the first decline.
 */
export const decideWithSelfConsistency = (input: {
  readonly request: DecisionRequest;
  readonly decide: (request: DecisionRequest) => Effect.Effect<CirceDecisionOutcome>;
  readonly watch: ReadonlyArray<string>;
}): Effect.Effect<ConsistencyOutcome> =>
  Effect.gen(function* () {
    const first = yield* input.decide(input.request);
    if (first.status === "decline") return { status: "decline", reason: first.reason };
    const second = yield* input.decide(input.request);
    if (second.status === "decline") return { status: "decline", reason: second.reason };
    for (const questionId of input.watch) {
      const verdict = arbitrateChoice(first.answers, second.answers, questionId);
      if (verdict === undefined) continue;
      if (verdict.status === "disagree") {
        return {
          status: "disagree",
          questionId,
          first: verdict.first,
          second: verdict.second,
        };
      }
    }
    return { status: "agree", model: first.model, answers: first.answers };
  });
