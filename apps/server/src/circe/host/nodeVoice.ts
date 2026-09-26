import {
  RelayVoiceSpeakResponse,
  RelayVoiceTranscribeResponse,
  type RelayVoiceTranscribeRequest,
} from "@circe/contracts/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../../cloud/config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { CirceHostOperationError } from "./nodeHost.ts";

/**
 * Circe's voice on this node: speech to words for spoken messages, and words
 * to speech for replies, both through Circe Mesh with the relay's key. The
 * node never holds a speech key. Understanding the words stays with Circe.
 */

const REQUEST_TIMEOUT = "25 seconds";

const RelayVoiceFailure = Schema.Struct({ code: Schema.String });

const failureMessages: Readonly<Record<string, string>> = {
  voice_not_configured: "Circe Mesh has no voice configured yet.",
  voice_environment_disabled: "Circe voice is turned off for this device in Circe Mesh.",
  voice_invalid_request: "I couldn't read that recording.",
  voice_upstream_failed: "The speech service didn't answer. Try again.",
};

const refuse = (reason: string) => new CirceHostOperationError({ reason });

export const makeNodeVoice = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((bytes) =>
        Option.isSome(bytes) ? new TextDecoder().decode(bytes.value).trim() : "",
      ),
      Effect.orElseSucceed(() => ""),
    );

  const route = Effect.gen(function* () {
    const [url, credential] = yield* Effect.all([
      readSecret(RELAY_URL_SECRET),
      readSecret(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (url.length === 0 || credential.length === 0) {
      return yield* refuse(
        "Voice needs this node linked to Circe Mesh. Link it under Settings > Connections.",
      );
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    return {
      base: `${url.replace(/\/+$/u, "")}/v1/environments/${encodeURIComponent(environmentId)}/voice`,
      credential,
    };
  });

  const call = <A, I>(path: "transcribe" | "speak", body: unknown, response: Schema.Codec<A, I>) =>
    Effect.gen(function* () {
      const relay = yield* route;
      const reply = yield* client
        .execute(
          HttpClientRequest.post(`${relay.base}/${path}`).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${relay.credential}`),
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        )
        .pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(() => refuse("I couldn't reach Circe Mesh for voice.")),
        );
      if (reply.status < 200 || reply.status >= 300) {
        const failure = yield* HttpClientResponse.schemaBodyJson(RelayVoiceFailure)(reply).pipe(
          Effect.option,
        );
        const code = Option.map(failure, (value) => value.code).pipe(Option.getOrElse(() => ""));
        return yield* refuse(
          failureMessages[code] ?? `Circe Mesh voice failed (HTTP ${reply.status}).`,
        );
      }
      return yield* HttpClientResponse.schemaBodyJson(response)(reply).pipe(
        Effect.mapError(() => refuse("Circe Mesh returned an unreadable voice response.")),
      );
    });

  return {
    transcribe: (input: RelayVoiceTranscribeRequest) =>
      call("transcribe", input, RelayVoiceTranscribeResponse).pipe(
        Effect.map((body) => body.text.trim()),
      ),
    speak: (text: string) => call("speak", { text }, RelayVoiceSpeakResponse),
  };
});
