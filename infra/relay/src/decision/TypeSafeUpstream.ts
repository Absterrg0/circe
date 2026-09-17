import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { RelayTypeSafeDecisionResponse } from "@t3tools/contracts/relay";

/**
 * Managed TypeSafe System One upstream.
 *
 * The relay is a pass-through: it attaches the deployment key to the request
 * body it was handed, calls TypeSafe, validates the response shape, and
 * returns it. It never interprets, stores, logs, or traces the request or
 * response body. Only method, route, status, and timing are observable.
 */

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
const SYSTEM_ONE_PATH = "/v1/systemone";
const REQUEST_TIMEOUT = "10 seconds";

export class TypeSafeUpstreamFailed extends Schema.TaggedError<TypeSafeUpstreamFailed>()(
  "TypeSafeUpstreamFailed",
  {
    /** A received rejection is distinct from a lost response or bad body. */
    outcome: Schema.Literals(["rejected", "overloaded", "unknown"]),
    cause: Schema.Defect(),
  },
) {}

export interface TypeSafeUpstreamShape {
  readonly run: (input: {
    readonly apiKey: Redacted.Redacted<string>;
    readonly baseUrl: string;
    readonly body: unknown;
  }) => Effect.Effect<typeof RelayTypeSafeDecisionResponse.Type, TypeSafeUpstreamFailed>;
}

export class TypeSafeUpstream extends Context.Service<TypeSafeUpstream, TypeSafeUpstreamShape>()(
  "@circe/relay/decision/TypeSafeUpstream",
) {}

export const layer = Layer.effect(
  TypeSafeUpstream,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return TypeSafeUpstream.of({
      run: (input) =>
        client
          .execute(
            HttpClientRequest.post(`${input.baseUrl.replace(/\/+$/u, "")}${SYSTEM_ONE_PATH}`).pipe(
              HttpClientRequest.setHeader(
                "Authorization",
                `Bearer ${Redacted.value(input.apiKey)}`,
              ),
              HttpClientRequest.setHeader("Content-Type", "application/json"),
              HttpClientRequest.bodyJsonUnsafe(input.body),
            ),
          )
          .pipe(
            Effect.mapError((cause) => new TypeSafeUpstreamFailed({ outcome: "unknown", cause })),
            Effect.flatMap((response) => {
              if (response.status < 200 || response.status >= 300) {
                return Effect.fail(
                  new TypeSafeUpstreamFailed({
                    outcome:
                      response.status === 429 || response.status === 529
                        ? "overloaded"
                        : response.status >= 400 && response.status < 500
                          ? "rejected"
                          : "unknown",
                    cause: { status: response.status },
                  }),
                );
              }
              // Decode into the wire shape so the relay returns only the known
              // fields and never echoes unexpected upstream content.
              return HttpClientResponse.schemaBodyJson(RelayTypeSafeDecisionResponse)(
                response,
              ).pipe(
                Effect.mapError(
                  (cause) => new TypeSafeUpstreamFailed({ outcome: "unknown", cause }),
                ),
              );
            }),
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(new TypeSafeUpstreamFailed({ outcome: "unknown", cause })),
            ),
          ),
    });
  }),
);
