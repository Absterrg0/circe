import {
  readDecisionResponse,
  type CirceDecisionOutcome,
  type DecisionRequest,
} from "@circe/core/decision";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../../cloud/config.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  CIRCE_DECISION_DEFAULT,
  CirceDecision,
  type CirceDecisionConfig,
} from "../Services/CirceDecision.ts";

const MAX_STATE_CHARS = 16_000;
const MAX_QUESTIONS = 64;
const RETRY_ATTEMPTS = 1;
const RETRY_DELAY = Duration.millis(250);
const SYSTEM_ONE_PATH = "/v1/systemone";

type DeclineReason = Extract<CirceDecisionOutcome, { status: "decline" }>["reason"];

const readConfig = (server: ServerConfig.ServerConfig["Service"]): CirceDecisionConfig => {
  const configured = server.circeDecision;
  if (configured === undefined) return CIRCE_DECISION_DEFAULT;
  return {
    enabled: configured.enabled === true,
    apiKey: configured.apiKey ?? "",
    model:
      configured.model !== undefined && configured.model.trim().length > 0
        ? configured.model
        : CIRCE_DECISION_DEFAULT.model,
    timeoutMs: configured.timeoutMs ?? CIRCE_DECISION_DEFAULT.timeoutMs,
    endpoint:
      configured.endpoint !== undefined && configured.endpoint.trim().length > 0
        ? configured.endpoint.replace(/\/+$/u, "")
        : CIRCE_DECISION_DEFAULT.endpoint,
  };
};

const decline = (reason: DeclineReason): CirceDecisionOutcome => ({ status: "decline", reason });

const stateSize = (state: unknown): number => {
  if (typeof state === "string") return state.length;
  try {
    return JSON.stringify(state ?? null).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * One outbound System One request per call, bounded and timeout-guarded. 429,
 * 529, and network failures retry once, then decline; a persistent failure is
 * a decline, never a failed turn. The resolved `response.model` is reported so
 * the caller records the exact version an alias resolved to.
 *
 * The node prefers a local `CIRCE_TYPESAFE_API_KEY`. When none is configured
 * and the node is linked to Circe Mesh, the same request is carried by the
 * relay, which holds the deployment key. The relay is a pass-through: state and
 * questions cross it in memory only and are never persisted, logged, or traced.
 */
export const CirceDecisionLive = Layer.effect(
  CirceDecision,
  Effect.gen(function* () {
    const server = yield* ServerConfig.ServerConfig;
    const client = yield* HttpClient.HttpClient;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const config = readConfig(server);

    const readSecret = (name: string): Effect.Effect<string | null> =>
      secrets.get(name).pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value).trim() : null,
        ),
        Effect.orElseSucceed(() => null),
      );

    /** The linked relay route, or null when this node is not linked. */
    const readRelayRoute = (): Effect.Effect<{
      readonly endpoint: string;
      readonly credential: string;
    } | null> =>
      Effect.gen(function* () {
        const [url, credential] = yield* Effect.all([
          readSecret(RELAY_URL_SECRET),
          readSecret(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
        ]);
        if (url === null || url.length === 0 || credential === null || credential.length === 0) {
          return null;
        }
        const environmentId = yield* serverEnvironment.getEnvironmentId;
        return {
          endpoint: `${url.replace(/\/+$/u, "")}/v1/environments/${encodeURIComponent(environmentId)}/typesafe/systemone`,
          credential,
        };
      }).pipe(Effect.orElseSucceed(() => null));

    const post = (
      httpRequest: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<CirceDecisionOutcome> => {
      const attempt = (attemptsLeft: number): Effect.Effect<CirceDecisionOutcome> =>
        Effect.gen(function* () {
          const response = yield* client
            .execute(httpRequest)
            .pipe(Effect.orElseSucceed(() => undefined));
          if (response === undefined) {
            if (attemptsLeft > 0) {
              yield* Effect.sleep(RETRY_DELAY);
              return yield* attempt(attemptsLeft - 1);
            }
            return decline("decision-network-error");
          }
          if (response.status === 429 || response.status === 529) {
            if (attemptsLeft > 0) {
              yield* Effect.sleep(RETRY_DELAY);
              return yield* attempt(attemptsLeft - 1);
            }
            return decline("decision-rate-limited");
          }
          if (response.status !== 200) {
            return decline("decision-http-error");
          }
          const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (body === undefined) return decline("decision-invalid-response");
          const parsed = readDecisionResponse(body);
          if (parsed === undefined) return decline("decision-invalid-response");
          return { status: "answered" as const, model: parsed.model, answers: parsed.answers };
        });
      return attempt(RETRY_ATTEMPTS).pipe(
        Effect.timeoutOption(Duration.millis(config.timeoutMs)),
        Effect.map((outcome) =>
          Option.isNone(outcome) ? decline("decision-timeout") : outcome.value,
        ),
        Effect.catchCause(() => Effect.succeed(decline("decision-network-error"))),
      );
    };

    const decide = (request: DecisionRequest): Effect.Effect<CirceDecisionOutcome> => {
      const questionCount = Object.keys(request.questions).length;
      if (questionCount === 0 || questionCount > MAX_QUESTIONS) {
        return Effect.succeed(decline("decision-invalid-response"));
      }
      if (stateSize(request.state) > MAX_STATE_CHARS) {
        return Effect.succeed(decline("source-too-large"));
      }
      // An explicit `CIRCE_TYPESAFE_ENABLED=false` wins even when a local key
      // is present. A keyless default (unset config) falls through to the
      // managed relay route.
      if (config.enabled !== true && config.apiKey.trim().length > 0) {
        return Effect.succeed(decline("decision-disabled"));
      }
      const model = request.model.trim().length > 0 ? request.model.trim() : config.model;
      const payload = { state: request.state, model, questions: request.questions };
      if (config.apiKey.trim().length > 0) {
        return post(
          HttpClientRequest.post(`${config.endpoint}${SYSTEM_ONE_PATH}`).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${config.apiKey}`),
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.bodyJsonUnsafe(payload),
          ),
        );
      }
      return Effect.gen(function* () {
        const route = yield* readRelayRoute();
        if (route === null) {
          return decline(config.enabled ? "decision-unconfigured" : "decision-disabled");
        }
        return yield* post(
          HttpClientRequest.post(route.endpoint).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${route.credential}`),
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.bodyJsonUnsafe(payload),
          ),
        );
      });
    };

    return { decide };
  }),
);

/** Disabled stub: no outbound request, always declines to the caller. */
export const CirceDecisionDisabledLive = Layer.succeed(CirceDecision, {
  decide: () => Effect.succeed({ status: "decline", reason: "decision-disabled" } as const),
});
