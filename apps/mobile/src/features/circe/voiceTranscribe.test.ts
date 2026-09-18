import { describe, expect, it } from "vite-plus/test";

import type { VoiceTranscriber } from "@circe/client/voice-input";

import { transcribeCapturedVoice } from "./voiceTranscribe";

function transcriberFor(text: string): VoiceTranscriber {
  return {
    prepare: async () => ({
      locale: "en-US",
      transcribe: async () => text,
    }),
  };
}

describe("transcribeCapturedVoice", () => {
  it("reports empty when nothing was captured", async () => {
    await expect(
      transcribeCapturedVoice(null, {
        getTranscriber: () => transcriberFor("hello"),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "empty" });
  });

  it("reports unavailable when the device has no transcriber", async () => {
    await expect(
      transcribeCapturedVoice("file:///recording.m4a", {
        getTranscriber: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("reports empty when transcription resolves to no words", async () => {
    await expect(
      transcribeCapturedVoice("file:///recording.m4a", {
        getTranscriber: () => transcriberFor("   "),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "empty" });
  });

  it("returns trimmed text when transcription succeeds", async () => {
    await expect(
      transcribeCapturedVoice("file:///recording.m4a", {
        getTranscriber: () => transcriberFor("  summarise my work  "),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "ready", text: "summarise my work" });
  });
});
