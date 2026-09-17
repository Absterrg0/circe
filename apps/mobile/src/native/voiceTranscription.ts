import type { VoiceTranscriber } from "@circe/client/voice-input";
import type { LocalLiveVoiceRecognizer } from "./voiceTranscription.android";

export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  return null;
}

export function getLocalLiveVoiceRecognizer(): LocalLiveVoiceRecognizer | null {
  return null;
}
