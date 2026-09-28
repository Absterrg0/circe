import type { EnvironmentThreadShell } from "@circe/client/state/shell";

import { isSidebarSubagentThread, resolveSidebarThreadStatus } from "../Sidebar.logic";
import type { CirceTaskState } from "./ui/StatusGlyph";

type OverviewThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "archivedAt"
  | "deletedAt"
  | "updatedAt"
  | "latestRun"
  | "runtime"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "lineage"
>;

export interface CirceOverviewSummary<T extends OverviewThread> {
  readonly running: number;
  readonly completedToday: number;
  readonly failed: number;
  /** Tasks waiting on the user, newest first. */
  readonly needs: ReadonlyArray<T>;
}

/** Task state in Circe's fixed vocabulary, from the typed thread shell. */
export function overviewTaskState(thread: OverviewThread): CirceTaskState {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input") return "needs";
  if (status === "working") return "running";
  if (status === "waiting") return "queued";
  if (status === "failed") return "failed";
  return thread.latestRun?.status === "completed" ? "done" : "settled";
}

function isSameLocalDay(iso: string, now: Date): boolean {
  const date = new Date(iso);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/**
 * The numbers the overview headline and stat row read. Subagent threads live
 * inside their parent task, so they are not counted twice.
 */
export function summarizeCirceOverview<T extends OverviewThread>(
  threads: ReadonlyArray<T>,
  now: Date,
): CirceOverviewSummary<T> {
  let running = 0;
  let completedToday = 0;
  let failed = 0;
  const needs: T[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (isSidebarSubagentThread(thread)) continue;
    const state = overviewTaskState(thread);
    if (state === "needs") needs.push(thread);
    else if (state === "running") running += 1;
    else if (state === "failed") failed += 1;
    const completedAt = thread.latestRun?.completedAt;
    if (
      thread.latestRun?.status === "completed" &&
      completedAt &&
      isSameLocalDay(completedAt, now)
    ) {
      completedToday += 1;
    }
  }
  needs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { running, completedToday, failed, needs };
}

const COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** "Two tasks need you." Small counts read as words, like the spoken report. */
export function overviewAttentionLine(
  needs: number,
  running: number,
): {
  readonly text: string;
  readonly tone: "attention" | "ember" | "quiet";
} {
  const count = (n: number) => COUNT_WORDS[n] ?? String(n);
  if (needs > 0) {
    return {
      text: `${count(needs)} task${needs === 1 ? " needs" : "s need"} you.`,
      tone: "attention",
    };
  }
  if (running > 0) {
    return {
      text: `${count(running)} task${running === 1 ? " is" : "s are"} running.`,
      tone: "ember",
    };
  }
  return { text: "Nothing needs you.", tone: "quiet" };
}

/** Plain time-of-day greeting for the overview headline. */
export function greetingForHour(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** "6m 12s", "48s", "1h 04m": elapsed work time for the activity table. */
export function formatRunDuration(
  startedAt: string | null,
  endedAt: string | null,
  now: Date,
): string | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
