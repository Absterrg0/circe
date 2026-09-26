import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/**
 * Circe voice upstream: one spoken message to text, and one reply to speech.
 *
 * Like the managed decision route this is a pass-through. The audio and the
 * text are held in memory for the one request and never stored, logged, or
 * traced. Understanding the words is Circe's job on the node, not the
 * relay's: this only turns speech into words and words into speech.
 */

export const OPENAI_TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";
export const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
export const VOICE_DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const VOICE_DEFAULT_SPEECH_MODEL = "gpt-4o-mini-tts";
const REQUEST_TIMEOUT = "20 seconds";

const extensionOf: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
};

const TranscriptionResponse = Schema.Struct({ text: Schema.String });

export class VoiceUpstreamFailed extends Schema.TaggedError<VoiceUpstreamFailed>()(
  "VoiceUpstreamFailed",
  {
    /** A rejected request (bad audio, bad key) is distinct from a lost response. */
    outcome: Schema.Literals(["rejected", "unknown"]),
    cause: Schema.Defect(),
  },
) {}

export interface VoiceUpstreamShape {
  readonly transcribe: (input: {
    readonly apiKey: Redacted.Redacted<string>;
    readonly model: string;
    readonly audio: Uint8Array;
    readonly mimeType: string;
    readonly vocabulary?: string;
  }) => Effect.Effect<string, VoiceUpstreamFailed>;
  /** Returns base64 MP3. */
  readonly speak: (input: {
    readonly apiKey: Redacted.Redacted<string>;
    readonly model: string;
    readonly voice: string;
    readonly text: string;
  }) => Effect.Effect<string, VoiceUpstreamFailed>;
}

export class VoiceUpstream extends Context.Service<VoiceUpstream, VoiceUpstreamShape>()(
  "@circe/relay/voice/VoiceUpstream",
) {}

const statusOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(
        new VoiceUpstreamFailed({
          outcome:
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
              ? "rejected"
              : "unknown",
          cause: { status: response.status },
        }),
      );

export const layer = Layer.effect(
  VoiceUpstream,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return VoiceUpstream.of({
      transcribe: (input) => {
        const form = new FormData();
        form.append(
          "file",
          new Blob([new Uint8Array(input.audio)], { type: input.mimeType }),
          `speech.${extensionOf[input.mimeType] ?? "webm"}`,
        );
        form.append("model", input.model);
        form.append("response_format", "json");
        if (input.vocabulary !== undefined && input.vocabulary.trim().length > 0) {
          form.append("prompt", input.vocabulary);
        }
        return client
          .execute(
            HttpClientRequest.post(OPENAI_TRANSCRIPTIONS_URL).pipe(
              HttpClientRequest.setHeader(
                "Authorization",
                `Bearer ${Redacted.value(input.apiKey)}`,
              ),
              HttpClientRequest.bodyFormData(form),
            ),
          )
          .pipe(
            Effect.mapError((cause) => new VoiceUpstreamFailed({ outcome: "unknown", cause })),
            Effect.flatMap(statusOk),
            Effect.flatMap((response) =>
              HttpClientResponse.schemaBodyJson(TranscriptionResponse)(response).pipe(
                Effect.mapError((cause) => new VoiceUpstreamFailed({ outcome: "unknown", cause })),
              ),
            ),
            Effect.map((body) => body.text.trim()),
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(new VoiceUpstreamFailed({ outcome: "unknown", cause })),
            ),
          );
      },
      speak: (input) =>
        client
          .execute(
            HttpClientRequest.post(OPENAI_SPEECH_URL).pipe(
              HttpClientRequest.setHeader(
                "Authorization",
                `Bearer ${Redacted.value(input.apiKey)}`,
              ),
              HttpClientRequest.bodyJsonUnsafe({
                model: input.model,
                voice: input.voice,
                input: input.text,
                response_format: "mp3",
              }),
            ),
          )
          .pipe(
            Effect.mapError((cause) => new VoiceUpstreamFailed({ outcome: "unknown", cause })),
            Effect.flatMap(statusOk),
            Effect.flatMap((response) =>
              response.arrayBuffer.pipe(
                Effect.mapError((cause) => new VoiceUpstreamFailed({ outcome: "unknown", cause })),
              ),
            ),
            Effect.map((buffer) => Encoding.encodeBase64(new Uint8Array(buffer))),
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(new VoiceUpstreamFailed({ outcome: "unknown", cause })),
            ),
          ),
    });
  }),
);
