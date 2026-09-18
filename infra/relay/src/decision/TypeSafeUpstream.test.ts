import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { TypeSafeUpstream, layer as typeSafeUpstreamLayer } from "./TypeSafeUpstream.ts";

const responseBody = {
  model: "jev-1.13.0",
  answers: {
    action: { type: "choice", choice: "stop", probabilities: { stop: 1 }, confidence: 0.9 },
  },
  usage: { input_tokens: 10, output_tokens: 2 },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const httpLayer = (handler: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );

const run = (
  http: Layer.Layer<HttpClient.HttpClient>,
  body: unknown = { state: { utterance: "stop auth" }, model: "jev-latest", questions: {} },
) =>
  Effect.gen(function* () {
    const upstream = yield* TypeSafeUpstream;
    return yield* upstream.run({
      apiKey: Redacted.make("deployment-key"),
      baseUrl: "https://api.typesafe.test",
      body,
    });
  }).pipe(Effect.provide(typeSafeUpstreamLayer.pipe(Layer.provide(http))));

describe("relay TypeSafe upstream", () => {
  it.effect("forwards the body with the deployment key and returns the known fields", () =>
    Effect.gen(function* () {
      let seenUrl: string | undefined;
      let seenAuthorization: string | undefined;
      let seenBody: string | undefined;
      const result = yield* run(
        httpLayer((request) => {
          seenUrl = request.url;
          seenAuthorization = request.headers.authorization;
          seenBody =
            request.body._tag === "Uint8Array"
              ? new TextDecoder().decode(request.body.body)
              : undefined;
          return jsonResponse(responseBody);
        }),
      );
      expect(seenUrl).toBe("https://api.typesafe.test/v1/systemone");
      expect(seenAuthorization).toBe("Bearer deployment-key");
      expect(seenBody).toContain("stop auth");
      expect(result.model).toBe("jev-1.13.0");
    }),
  );

  it.effect("classifies an overloaded upstream without retrying forever", () =>
    Effect.gen(function* () {
      const outcome = yield* run(httpLayer(() => jsonResponse({ error: "busy" }, 429))).pipe(
        Effect.flip,
      );
      expect(outcome.outcome).toBe("overloaded");
    }),
  );

  it.effect("classifies a rejected upstream", () =>
    Effect.gen(function* () {
      const outcome = yield* run(httpLayer(() => jsonResponse({ error: "bad" }, 401))).pipe(
        Effect.flip,
      );
      expect(outcome.outcome).toBe("rejected");
    }),
  );

  it.effect("fails on a response missing the model field", () =>
    Effect.gen(function* () {
      const outcome = yield* run(httpLayer(() => jsonResponse({ answers: {}, usage: {} }))).pipe(
        Effect.flip,
      );
      expect(outcome.outcome).toBe("unknown");
    }),
  );
});
