import { setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";

/**
 * The one owner of the recording audio session.
 *
 * Dictation and live conversation both capture the microphone and both need the
 * same session shape, so the calls live here rather than being duplicated per
 * feature. Expo does not deactivate AVAudioSession when recording stops or its
 * category changes, so release is explicit: without it a finished capture keeps
 * interrupted app audio muted.
 */

export async function configureVoiceAudioForCapture(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceAudio();
    } catch {
      // Keep the setup error. The caller has not started a capture yet.
    }
    throw error;
  }
}

export async function releaseVoiceAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}
