import { ProviderInstanceId } from "@circe/contracts";
import type { DecisionRequest } from "@circe/core/decision";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import {
  buildDecisionPrompt,
  makeCirceDecisionFallback,
  CirceDecisionFallbackLive,
  validateDecisionAnswers,
} from "./CirceDecisionFallback.ts";

const request: DecisionRequest = {
  model: "jev-latest",
  state: { goal: "open the docs", surface: { elements: [{ id: "ax:1", name: "Search" }] } },
  questions: {
    action: {
      type: "choice",
      instructions: "Which action?",
      criteria: { click: null, type: null, done: null },
    },
    element: {
      type: "choice",
      instructions: "Which element?",
      criteria: { "ax:1": null, none: null },
    },
    goal_reached: {
      type: "noul",
      instructions: "Is the goal satisfied?",
    },
  },
};

it("builds a bounded prompt that lists only the offered keys", () => {
  const prompt = buildDecisionPrompt(request);
  assert.include(prompt, "action (choice)");
  assert.include(prompt, "click | type | done");
  assert.include(prompt, "goal_reached (predicate)");
  assert.notInclude(prompt, "invented-key");
});

it("validates provider answers against the request's own keys", () => {
  const validated = validateDecisionAnswers(request, {
    answers: [
      { id: "action", choice: "type", confidence: 0.9 },
      // Missing confidence stays unknown: the answer is dropped rather than
      // promoted to a high-confidence choice the provider never made.
      { id: "element", choice: "ax:1" },
      { id: "goal_reached", noul: 0.8 },
      // Unknown key and unknown question are dropped, never coerced.
      { id: "action", choice: "invented" },
      { id: "unknown-question", choice: "type" },
    ],
  });
  assert.deepStrictEqual(validated, {
    action: { type: "choice", choice: "type", probabilities: { type: 0.9 }, confidence: 0.9 },
    goal_reached: { type: "noul", noul: 0.8 },
  });
  // An answer set with no valid key is a decline, not a guess.
  assert.isUndefined(
    validateDecisionAnswers(request, { answers: [{ id: "action", choice: "invented" }] }),
  );
});

const fallbackLayer = (options: { readonly providerAnswers: unknown }) =>
  CirceDecisionFallbackLive.pipe(
    Layer.provide(
      Layer.succeed(
        CirceDecision,
        CirceDecision.of({
          decide: () =>
            Effect.succeed({ status: "decline" as const, reason: "decision-disabled" as const }),
        }),
      ),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry)({
        getTextGenerationForInstance: () =>
          Effect.succeed({
            generateStructured: () => Effect.succeed(options.providerAnswers),
          } as never),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed({
          circeSupervisorModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
        } as never),
      }),
    ),
    Layer.provide(NodeServices.layer),
  );

it.effect("falls back to the ordinary provider when TypeSafe declines", () =>
  Effect.gen(function* () {
    const decision = yield* CirceDecision;
    const outcome = yield* decision.decide(request);
    assert.strictEqual(outcome.status, "answered");
    if (outcome.status !== "answered") return;
    assert.strictEqual(outcome.model, "codex/gpt-5.6-sol");
    assert.strictEqual(outcome.answers.action?.type, "choice");
  }).pipe(
    Effect.provide(
      fallbackLayer({
        providerAnswers: {
          answers: [
            { id: "action", choice: "click", confidence: 0.95 },
            { id: "element", choice: "ax:1", confidence: 0.95 },
          ],
        },
      }),
    ),
  ),
);

it.effect("provider-first consults the provider before the primary", () =>
  Effect.gen(function* () {
    const decision = yield* CirceDecision;
    const outcome = yield* decision.decide(request);
    assert.strictEqual(outcome.status, "answered");
    if (outcome.status !== "answered") return;
    assert.strictEqual(outcome.model, "codex/gpt-5.6-sol");
  }).pipe(
    Effect.provide(
      makeCirceDecisionFallback({ preferProvider: true }).pipe(
        Layer.provide(
          Layer.succeed(
            CirceDecision,
            CirceDecision.of({
              // The primary would answer this request; provider-first must not
              // reach it while the provider answers.
              decide: () =>
                Effect.succeed({
                  status: "answered" as const,
                  model: "primary",
                  answers: {
                    action: {
                      type: "choice" as const,
                      choice: "type",
                      probabilities: { type: 1 },
                      confidence: 1,
                    },
                  },
                }),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry)({
            getTextGenerationForInstance: () =>
              Effect.succeed({
                generateStructured: () =>
                  Effect.succeed({
                    answers: [{ id: "action", choice: "click", confidence: 0.95 }],
                  }),
              } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              circeSupervisorModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
            } as never),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("provider-first falls back to the primary when the provider cannot answer", () =>
  Effect.gen(function* () {
    const decision = yield* CirceDecision;
    const outcome = yield* decision.decide(request);
    assert.strictEqual(outcome.status, "answered");
    if (outcome.status !== "answered") return;
    assert.strictEqual(outcome.model, "primary");
  }).pipe(
    Effect.provide(
      makeCirceDecisionFallback({ preferProvider: true }).pipe(
        Layer.provide(
          Layer.succeed(
            CirceDecision,
            CirceDecision.of({
              decide: () =>
                Effect.succeed({
                  status: "answered" as const,
                  model: "primary",
                  answers: {},
                }),
            }),
          ),
        ),
        Layer.provide(
          Layer.mock(ProviderRegistry)({
            getTextGenerationForInstance: () =>
              Effect.succeed({
                generateStructured: () => Effect.succeed({ answers: [] }),
              } as never),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              circeSupervisorModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.6-sol",
              },
            } as never),
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("stays declined when the provider answers no valid key", () =>
  Effect.gen(function* () {
    const decision = yield* CirceDecision;
    const outcome = yield* decision.decide(request);
    assert.strictEqual(outcome.status, "decline");
  }).pipe(
    Effect.provide(
      fallbackLayer({ providerAnswers: { answers: [{ id: "action", choice: "invented" }] } }),
    ),
  ),
);

it.effect("does not fall back for a decline the primary answered deliberately", () =>
  Effect.gen(function* () {
    const decision = yield* CirceDecision;
    const outcome = yield* decision.decide(request);
    assert.strictEqual(outcome.status, "decline");
    if (outcome.status !== "decline") return;
    assert.strictEqual(outcome.reason, "decision-invalid-response");
  }).pipe(
    Effect.provide(
      CirceDecisionFallbackLive.pipe(
        Layer.provide(
          Layer.succeed(
            CirceDecision,
            CirceDecision.of({
              decide: () =>
                Effect.succeed({
                  status: "decline" as const,
                  reason: "decision-invalid-response" as const,
                }),
            }),
          ),
        ),
        Layer.provide(Layer.mock(ProviderRegistry)({})),
        Layer.provide(Layer.mock(ServerSettingsService)({})),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it("decodes the provider body shape the fallback expects", () => {
  const decoded = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        answers: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            choice: Schema.optionalKey(Schema.String),
            noul: Schema.optionalKey(Schema.Number),
          }),
        ),
      }),
    ),
  )('{"answers":[{"id":"action","choice":"done"}]}');
  assert.deepStrictEqual(decoded, { answers: [{ id: "action", choice: "done" }] });
});
