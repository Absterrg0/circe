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

import * as ServerConfig from "../../config.ts";
import {
  T3CODE_DECISION_DEFAULT,
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
  if (configured === undefined) return T3CODE_DECISION_DEFAULT;
  return {
    enabled: configured.enabled === true,
    apiKey: configured.apiKey ?? "",
    model:
      configured.model !== undefined && configured.model.trim().length > 0
        ? configured.model
        : T3CODE_DECISION_DEFAULT.model,
    timeoutMs: configured.timeoutMs ?? T3CODE_DECISION_DEFAULT.timeoutMs,
    endpoint:
      configured.endpoint !== undefined && configured.endpoint.trim().length > 0
        ? configured.endpoint.replace(/\/+$/u, "")
        : T3CODE_DECISION_DEFAULT.endpoint,
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
 */
export const CirceDecisionLive = Layer.effect(
  CirceDecision,
  Effect.gen(function* () {
    const server = yield* ServerConfig.ServerConfig;
    const client = yield* HttpClient.HttpClient;
    const config = readConfig(server);

    const decide = (request: DecisionRequest): Effect.Effect<CirceDecisionOutcome> => {
      if (config.enabled !== true) {
        return Effect.succeed(decline("decision-disabled"));
      }
      if (config.apiKey.trim().length === 0) {
        return Effect.succeed(decline("decision-unconfigured"));
      }
      const questionCount = Object.keys(request.questions).length;
      if (questionCount === 0 || questionCount > MAX_QUESTIONS) {
        return Effect.succeed(decline("decision-invalid-response"));
      }
      if (stateSize(request.state) > MAX_STATE_CHARS) {
        return Effect.succeed(decline("source-too-large"));
      }
      const model = request.model.trim().length > 0 ? request.model.trim() : config.model;
      return Effect.gen(function* () {
        const httpRequest = HttpClientRequest.post(`${config.endpoint}${SYSTEM_ONE_PATH}`).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${config.apiKey}`),
          HttpClientRequest.setHeader("Content-Type", "application/json"),
          HttpClientRequest.bodyJsonUnsafe({
            state: request.state,
            model,
            questions: request.questions,
          }),
        );
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
        return yield* attempt(RETRY_ATTEMPTS).pipe(
          Effect.timeoutOption(Duration.millis(config.timeoutMs)),
          Effect.map((outcome) =>
            Option.isNone(outcome) ? decline("decision-timeout") : outcome.value,
          ),
          Effect.catchCause(() => Effect.succeed(decline("decision-network-error"))),
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
