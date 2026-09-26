import type { EnvironmentId } from "@circe/contracts";
import { useSyncExternalStore } from "react";

/**
 * Bot counts reported by each node's roster subscription, so the sidebar
 * heading can total them without one component subscribing to every node.
 */
const counts = new Map<EnvironmentId, number>();
const listeners = new Set<() => void>();
let total = 0;

function publish(): void {
  let next = 0;
  for (const value of counts.values()) next += value;
  if (next === total) return;
  total = next;
  for (const listener of listeners) listener();
}

export function reportBotCount(environmentId: EnvironmentId, count: number | null): void {
  if (count === null || count === 0) counts.delete(environmentId);
  else counts.set(environmentId, count);
  publish();
}

export function useTotalBotCount(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => total,
  );
}
