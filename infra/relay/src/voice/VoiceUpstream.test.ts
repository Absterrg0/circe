import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  OPENAI_SPEECH_URL,
  OPENAI_TRANSCRIPTIONS_URL,
  VoiceUpstream,
  layer,
} from "./VoiceUpstream.ts";

const httpLayer = (handler: (request: HttpClientRequest.HttpClientRequest) => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, handler(request))),
    ),
  );

const withUpstream = <A, E>(
  http: Layer.Layer<HttpClient.HttpClient>,
  use: (upstream: VoiceUpstream["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(Effect.service(VoiceUpstream), use).pipe(
    Effect.provide(layer.pipe(Layer.provide(http))),
  );

const apiKey = Redacted.make("deployment-key");

describe("relay Circe voice upstream", () => {
  it.effect(
    "sends the audio, model and vocabulary with the deployment key, and returns the words",
    () =>
      Effect.gen(function* () {
        let seen:
          | { url: string; authorization: string | undefined; form: FormData | undefined }
          | undefined;
        const text = yield* withUpstream(
          httpLayer((request) => {
            seen = {
              url: request.url,
              authorization: request.headers.authorization,
              form: request.body._tag === "FormData" ? request.body.formData : undefined,
            };
            return Response.json({ text: " stop the billing agent " });
          }),
          (upstream) =>
            upstream.transcribe({
              apiKey,
              model: "gpt-4o-mini-transcribe",
              audio: new Uint8Array([1, 2, 3]),
              mimeType: "audio/webm",
              vocabulary: "billing, compiler",
            }),
        );
        expect(text).toBe("stop the billing agent");
        expect(seen?.url).toBe(OPENAI_TRANSCRIPTIONS_URL);
        expect(seen?.authorization).toBe("Bearer deployment-key");
        expect(seen?.form?.get("model")).toBe("gpt-4o-mini-transcribe");
        expect(seen?.form?.get("prompt")).toBe("billing, compiler");
        expect((seen?.form?.get("file") as File | null)?.name).toBe("speech.webm");
      }),
  );

  it.effect("returns spoken replies as base64 MP3", () =>
    Effect.gen(function* () {
      let body: string | undefined;
      const audio = yield* withUpstream(
        httpLayer((request) => {
          expect(request.url).toBe(OPENAI_SPEECH_URL);
          body =
            request.body._tag === "Uint8Array"
              ? new TextDecoder().decode(request.body.body)
              : undefined;
          return new Response(new Uint8Array([9, 8, 7]), {
            headers: { "content-type": "audio/mpeg" },
          });
        }),
        (upstream) =>
          upstream.speak({ apiKey, model: "gpt-4o-mini-tts", voice: "marin", text: "Stopped it." }),
      );
      expect(audio).toBe(Encoding.encodeBase64(new Uint8Array([9, 8, 7])));
      expect(body).toContain('"model":"gpt-4o-mini-tts"');
      expect(body).toContain('"voice":"marin"');
      expect(body).toContain('"input":"Stopped it."');
    }),
  );

  it.effect("tells a rejected request from a lost one", () =>
    Effect.gen(function* () {
      const rejected = yield* withUpstream(
        httpLayer(() => Response.json({ error: "bad audio" }, { status: 400 })),
        (upstream) => upstream.speak({ apiKey, model: "m", voice: "v", text: "x" }),
      ).pipe(Effect.flip);
      expect(rejected.outcome).toBe("rejected");
      const lost = yield* withUpstream(
        httpLayer(() => Response.json({ error: "down" }, { status: 503 })),
        (upstream) => upstream.speak({ apiKey, model: "m", voice: "v", text: "x" }),
      ).pipe(Effect.flip);
      expect(lost.outcome).toBe("unknown");
    }),
  );
});
