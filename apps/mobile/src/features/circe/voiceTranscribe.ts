import type { VoiceTranscriber } from "@circe/client/voice-input";

export type VoiceTranscriptOutcome =
  | { readonly status: "unavailable" }
  | { readonly status: "empty" }
  | { readonly status: "ready"; readonly text: string };

/**
 * Turns a captured voice recording into submittable text.
 *
 * The listening surface recorded the mic for its meter and then threw the
 * file away, so speaking never reached the turn pipeline and never got a
 * reply. This is the decision seam between capture and submission: no
 * recording means nothing was caught, no transcriber means this device
 * cannot do on-device transcription, and blank transcription means the
 * speech did not resolve to words. Callers map each outcome to copy instead
 * of guessing.
 */
export async function transcribeCapturedVoice(
  uri: string | null,
  input: {
    readonly getTranscriber: () => VoiceTranscriber | null;
    readonly signal: AbortSignal;
  },
): Promise<VoiceTranscriptOutcome> {
  if (!uri) return { status: "empty" };
  const transcriber = input.getTranscriber();
  if (!transcriber) return { status: "unavailable" };
  const prepared = await transcriber.prepare({ signal: input.signal });
  const text = (await prepared.transcribe(uri, { signal: input.signal })).trim();
  if (text.length === 0) return { status: "empty" };
  return { status: "ready", text };
}
