import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { readDecisionResponse, type DecisionRequest } from "@circe/core/decision";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { CirceDecision } from "./Services/CirceDecision.ts";
import { CirceDecisionDisabledLive, CirceDecisionLive } from "./Layers/CirceDecision.ts";

const request: DecisionRequest = {
  state: { utterance: "stop authentication" },
  model: "jev-latest",
  questions: {
    action: {
      type: "choice",
      instructions: "Which action does the user request?",
      criteria: { stop: "Interrupt work", start: "Create work" },
    },
    destination_negated: {
      type: "noul",
      instructions: "Does the user rule out the named target?",
    },
  },
};

const responseBody = {
  model: "jev-1.13.0",
  answers: {
    action: {
      type: "choice",
      choice: "stop",
      probabilities: { stop: 0.9, start: 0.1 },
      confidence: 0.83,
    },
    destination_negated: { type: "noul", noul: 0.02 },
  },
  usage: { input_tokens: 100, output_tokens: 12 },
};

const configLayer = (circeDecision: ServerConfig.CirceDecisionRuntimeConfig) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (base) => ServerConfig.make({ ...base, circeDecision })),
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "circe-decision" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const parseUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const parseJson = (text: string): unknown => {
  try {
    return parseUnknownJson(text);
  } catch {
    return undefined;
  }
};

const httpLayer = (handler: (url: string, body: unknown) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) =>
      Effect.sync(() => {
        const decoded =
          req.body._tag === "Uint8Array" ? new TextDecoder().decode(req.body.body) : "";
        return HttpClientResponse.fromWeb(req, handler(req.url, parseJson(decoded)));
      }),
    ),
  );

const enabledConfig: ServerConfig.CirceDecisionRuntimeConfig = {
  enabled: true,
  apiKey: "test-key",
  model: "jev-latest",
  timeoutMs: 1_500,
  endpoint: "https://api.typesafe.test",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const decide = (
  cfg: ServerConfig.CirceDecisionRuntimeConfig,
  http: Layer.Layer<HttpClient.HttpClient>,
  decisionRequest: DecisionRequest = request,
) =>
  Effect.gen(function* () {
    const service = yield* CirceDecision;
    return yield* service.decide(decisionRequest);
  }).pipe(
    Effect.provide(CirceDecisionLive.pipe(Layer.provide(Layer.mergeAll(configLayer(cfg), http)))),
  );

describe("CirceDecision service", () => {
  it.effect("declines when disabled without any request", () =>
    Effect.gen(function* () {
      const service = yield* CirceDecision;
      const outcome = yield* service.decide(request);
      assert.deepStrictEqual(outcome, { status: "decline", reason: "decision-disabled" });
    }).pipe(Effect.provide(CirceDecisionDisabledLive)),
  );

  it.effect("declines decision-disabled when the live layer is disabled", () =>
    Effect.gen(function* () {
      const outcome = yield* decide(
        { ...enabledConfig, enabled: false },
        httpLayer(() => jsonResponse(responseBody)),
      );
      assert.deepStrictEqual(outcome, { status: "decline", reason: "decision-disabled" });
    }),
  );

  it.effect("declines decision-unconfigured when no key is present", () =>
    Effect.gen(function* () {
      const outcome = yield* decide(
        { ...enabledConfig, apiKey: "" },
        httpLayer(() => jsonResponse(responseBody)),
      );
      assert.deepStrictEqual(outcome, { status: "decline", reason: "decision-unconfigured" });
    }),
  );

  it.live("returns the parsed answers and records the resolved model", () =>
    Effect.gen(function* () {
      let sentBody: { readonly model?: unknown; readonly questions?: unknown } | undefined;
      const outcome = yield* decide(
        enabledConfig,
        httpLayer((url, body) => {
          sentBody = body as typeof sentBody;
          assert.strictEqual(url, "https://api.typesafe.test/v1/systemone");
          return jsonResponse(responseBody);
        }),
      );
      assert.strictEqual(outcome.status, "answered");
      if (outcome.status !== "answered") return;
      assert.strictEqual(outcome.model, "jev-1.13.0");
      const action = outcome.answers.action;
      assert.strictEqual(action?.type, "choice");
      if (action?.type === "choice") {
        assert.strictEqual(action.choice, "stop");
        assert.strictEqual(action.confidence, 0.83);
      }
      assert.strictEqual(sentBody?.model, "jev-latest");
    }),
  );

  it.live("declines decision-rate-limited after bounded retries on 429", () =>
    Effect.gen(function* () {
      let calls = 0;
      const outcome = yield* decide(
        enabledConfig,
        httpLayer(() => {
          calls += 1;
          return jsonResponse({ error: "rate limited" }, 429);
        }),
      );
      assert.deepStrictEqual(outcome, { status: "decline", reason: "decision-rate-limited" });
      assert.strictEqual(calls, 2);
    }),
  );

  it.live("declines decision-timeout when the request never answers", () =>
    Effect.gen(function* () {
      const outcome = yield* decide(
        { ...enabledConfig, timeoutMs: 50 },
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
      );
      assert.deepStrictEqual(outcome, { status: "decline", reason: "decision-timeout" });
    }),
  );

  it.live("declines decision-invalid-response on a malformed body", () =>
    Effect.gen(function* () {
      const outcome = yield* decide(
        enabledConfig,
        httpLayer(() =>
          jsonResponse({ model: "jev-1.13.0", answers: { action: { type: "choice" } } }),
        ),
      );
      assert.deepStrictEqual(outcome, { status: "decline", reason: "decision-invalid-response" });
    }),
  );

  it.effect("declines source-too-large without sending a request", () =>
    Effect.gen(function* () {
      const outcome = yield* decide(
        enabledConfig,
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not send an oversized request")),
        ),
        { ...request, state: "a".repeat(20_000) },
      );
      assert.deepStrictEqual(outcome, { status: "decline", reason: "source-too-large" });
    }),
  );
});

describe("readDecisionResponse", () => {
  it("reads choice, score, and noul answers", () => {
    const parsed = readDecisionResponse({
      model: "jev-1.13.0",
      answers: {
        choice: { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 0.9 },
        score: {
          type: "score",
          score: 0.4,
          legend: { "0": "lo", "1": "hi" },
          probabilities: { "0": 0.6, "1": 0.4 },
          confidence: 0.7,
        },
        noul: { type: "noul", noul: 0.2 },
      },
    });
    assert.isDefined(parsed);
    assert.strictEqual(parsed?.answers.score?.type, "score");
    assert.strictEqual(parsed?.model, "jev-1.13.0");
  });

  it("rejects a probability outside [0,1]", () => {
    assert.isUndefined(
      readDecisionResponse({
        model: "jev-1.13.0",
        answers: {
          choice: {
            type: "choice",
            choice: "a",
            probabilities: { a: 1.2, b: -0.2 },
            confidence: 0.9,
          },
        },
      }),
    );
  });
});
