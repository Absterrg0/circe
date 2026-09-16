import { useSyncExternalStore } from "react";

import { loadPreferences, updatePreferences } from "../../persistence/imperative";

/**
 * Guest mode lets someone use Circe without a Circe Mesh account.
 *
 * The signed-out gate has to answer "is the user a guest?" before it can decide
 * whether to redirect, and the welcome screen can enable guest mode in the
 * middle of a session. Both read the same in-memory value so enabling guest
 * mode takes effect without a reload, while the preference makes it survive a
 * restart.
 *
 * Kept apart from connectOnboardingOptOut.ts so the gate and the settings
 * screen can share it without either importing the other.
 */
let current: boolean | null = null;
let loaded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeGuestMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readSnapshot(): boolean | null {
  return current;
}

/** Loads the stored decision once; concurrent callers share the read. */
export function ensureGuestModeLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  inFlight ??= (async () => {
    try {
      const preferences = await loadPreferences();
      current = preferences.guestMode === true;
    } catch {
      // An unreadable preference is not permission to skip onboarding.
      current = false;
    }
    loaded = true;
    inFlight = null;
    emit();
  })();
  return inFlight;
}

/** Applies the decision in memory now and persists it for the next launch. */
export async function setGuestMode(enabled: boolean): Promise<void> {
  current = enabled;
  loaded = true;
  emit();
  await updatePreferences(() => ({ guestMode: enabled }));
}

export function useGuestMode(): boolean | null {
  return useSyncExternalStore(subscribeGuestMode, readSnapshot, readSnapshot);
}
