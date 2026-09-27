import type { CirceDecisionOutcome, DecisionAnswers, DecisionRequest } from "@circe/core/decision";
import { readDecisionResponse } from "@circe/core/decision";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";

/**
 * Ordinary-provider judgement for the finite decision protocol.
 *
 * These are three distinct roles, and this module only implements the middle
 * one: the host deterministically validates and executes (key membership and
 * the executor in `CirceComputerUse`), the provider supplies judgement by
 * answering finite questions over supplied state, and TypeSafe is an optional
 * alternative selector. Provider-first mode returns a valid provider answer
 * directly; it is not independently judged by TypeSafe.
 *
 * The host validates every answer against the question's own keys, so a
 * provider can never invent an element, a key, or an action outside the
 * offered set. Confidence is passed through as reported; it is never
 * synthesized.
 */

const FALLBACK_DECLINE_REASONS: ReadonlySet<string> = new Set([
  "decision-disabled",
  "decision-unconfigured",
  "decision-invalid-response",
  "decision-timeout",
  "decision-rate-limited",
  "decision-network-error",
  "decision-http-error",
]);

const ProviderAnswer = Schema.Struct({
  id: Schema.String,
  choice: Schema.optionalKey(Schema.String),
  noul: Schema.optionalKey(Schema.Number),
  confidence: Schema.optionalKey(Schema.Number),
});
const ProviderAnswerList = Schema.Struct({
  answers: Schema.Array(ProviderAnswer),
});
export type ProviderAnswerList = typeof ProviderAnswerList.Type;

const MAX_STATE_CHARS = 16_000;
const MAX_QUESTIONS = 64;
const FALLBACK_TIMEOUT = "30 seconds";

/**
 * The decision skill. The provider supplies judgement for one step; the
 * grounded executor performs it, so every answer must be a listed key and
 * the rules below are the whole contract.
 */
export const DECISION_SKILL = [
  "You are the decision tier for one computer-use step. You never act directly: you answer one bounded decision, and a grounded executor performs the chosen action on the real screen.",
  "Rules:",
  "- Every target is grounded: choose one of the listed element keys, or none. Never describe an element or invent one.",
  "- Pick one action per step. Choose done only when the observed state already shows the goal's result, not because a control the goal would use is present.",
  "- A field value or state shown in the state is the observed truth: use it to tell whether an action already worked.",
  "- Prefer the action the goal names next. Do not repeat an action whose history line shows it did not change the surface.",
  "- When surfaceChangedAfterLastAction is false, the last action had no visible effect: either the observed state already satisfies the goal (choose done) or the action targeted the wrong control.",
  "- Omit a question you cannot answer from the state. Never invent keys or values.",
].join("\n");

/** A bounded, key-only prompt: the provider sees the finite sets, never IDs. */
export function buildDecisionPrompt(request: DecisionRequest): string {
  const state =
    typeof request.state === "string"
      ? request.state.slice(0, MAX_STATE_CHARS)
      : JSON.stringify(request.state ?? null).slice(0, MAX_STATE_CHARS);
  const questions = Object.entries(request.questions).slice(0, MAX_QUESTIONS);
  const lines: Array<string> = [DECISION_SKILL, `State: ${state}`, "Questions:"];
  for (const [id, question] of questions) {
    if (question.type === "choice") {
      // Labels are the whole point: a key alone is an opaque id, and the
      // model cannot pick the control the goal names without its description.
      const keys = Object.entries(question.criteria)
        .map(([key, label]) => (label === null ? key : `${key} => ${String(label).slice(0, 120)}`))
        .join(" | ");
      lines.push(
        `- ${id} (choice): ${question.instructions} Keys: ${keys.slice(0, 6_000)}${keys.length > 6_000 ? " …" : ""}`,
      );
    } else if (question.type === "noul") {
      lines.push(`- ${id} (predicate): ${question.instructions} Answer 0 or 1.`);
    } else {
      lines.push(`- ${id} (score): ${question.instructions}`);
    }
  }
  lines.push(
    // One shape for every answer, as the reply schema reads it: a predicate
    // outside the list would be discarded with the whole reply.
    'Reply with JSON only, one entry per question you answer: {"answers":[{"id":"<choice question id>","choice":"<key>","confidence":0.9},{"id":"<predicate question id>","noul":1}]}.',
  );
  return lines.join("\n");
}

/**
 * Validate provider answers against the request's own questions. Unknown keys,
 * unknown question ids, and out-of-range probabilities are dropped, never
 * coerced.
 */
export function validateDecisionAnswers(
  request: DecisionRequest,
  answers: ProviderAnswerList,
): DecisionAnswers | undefined {
  const out: Record<string, DecisionAnswers[string]> = {};
  for (const answer of answers.answers) {
    const question = request.questions[answer.id];
    if (question === undefined) continue;
    if (question.type === "choice") {
      if (answer.choice === undefined) continue;
      if (!Object.prototype.hasOwnProperty.call(question.criteria, answer.choice)) continue;
      // A self-reported confidence is the provider's own number. Missing or
      // out-of-range confidence stays unknown: synthesizing a high value here
      // would erase the difference between a confident answer and a guess.
      const confidence = answer.confidence;
      if (confidence === undefined || !(confidence >= 0 && confidence <= 1)) continue;
      out[answer.id] = {
        type: "choice",
        choice: answer.choice,
        probabilities: { [answer.choice]: confidence },
        confidence,
      };
      continue;
    }
    if (question.type === "noul") {
      if (answer.noul === undefined || answer.noul < 0 || answer.noul > 1) continue;
      out[answer.id] = { type: "noul", noul: answer.noul };
      continue;
    }
    // Score questions carry no selectable key; the loop never uses them.
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export interface CirceDecisionFallbackOptions {
  /**
   * Ask the provider first and keep TypeSafe as the safety net. Desktop
   * missions use this so the node's own model supplies the judgement while
   * the grounded executor stays authoritative.
   */
  readonly preferProvider?: boolean;
}

export const makeCirceDecisionFallback = (options: CirceDecisionFallbackOptions = {}) =>
  Layer.effect(
    CirceDecision,
    Effect.gen(function* () {
      const primary = yield* CirceDecision;
      const providerRegistry = yield* ProviderRegistry;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsService;

      const askProvider = Effect.fn("CirceDecisionFallback.askProvider")(function* (
        request: DecisionRequest,
      ) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.catchCause(() => Effect.succeed(null)),
        );
        if (settings === null) return undefined;
        const selection =
          settings.circeSupervisorModelSelection ?? settings.circeDefaultModelSelection;
        if (selection === undefined) return undefined;
        const generation = yield* providerRegistry
          .getTextGenerationForInstance(selection.instanceId)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
        if (generation === undefined) return undefined;
        const generated = yield* Effect.scoped(
          fileSystem.makeTempDirectoryScoped({ prefix: "circe-decision-" }).pipe(
            Effect.flatMap((cwd) =>
              generation.generateStructured({
                cwd,
                prompt: buildDecisionPrompt(request),
                outputSchema: ProviderAnswerList,
                modelSelection: selection,
              }),
            ),
          ),
        ).pipe(
          Effect.timeoutOption(FALLBACK_TIMEOUT),
          Effect.catchCause(() => Effect.succeed(Option.none())),
        );
        if (Option.isNone(generated)) {
          yield* Effect.logWarning("Circe decision provider fallback produced no answer");
          return undefined;
        }
        const validated = validateDecisionAnswers(request, generated.value);
        if (validated === undefined) {
          yield* Effect.logWarning("Circe decision provider fallback answered no valid key");
          return undefined;
        }
        return { selection: `${selection.instanceId}/${selection.model}`, answers: validated };
      });

      const answered = (fallback: {
        readonly selection: string;
        readonly answers: DecisionAnswers;
      }): CirceDecisionOutcome => ({
        status: "answered",
        model: fallback.selection,
        answers: fallback.answers,
      });

      const decide = Effect.fn("CirceDecisionFallback.decide")(function* (
        request: DecisionRequest,
      ) {
        if (options.preferProvider === true) {
          const preferred = yield* askProvider(request);
          if (preferred !== undefined) return answered(preferred);
          return yield* primary.decide(request);
        }
        const outcome = yield* primary.decide(request);
        if (outcome.status === "answered") return outcome;
        if (!FALLBACK_DECLINE_REASONS.has(outcome.reason)) return outcome;
        const fallback = yield* askProvider(request);
        if (fallback === undefined) return outcome;
        return answered(fallback);
      });

      return CirceDecision.of({ decide });
    }),
  );

export const CirceDecisionFallbackLive = makeCirceDecisionFallback();

/** Desktop missions: the provider leads and TypeSafe remains the safety net. */
export const CirceDecisionProviderFirstLive = makeCirceDecisionFallback({ preferProvider: true });

/** Re-exported so callers can log the raw provider body shape in tests. */
export { readDecisionResponse };
