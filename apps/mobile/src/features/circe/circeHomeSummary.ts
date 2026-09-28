import type { EnvironmentThreadShell } from "@circe/client/state/shell";

type HomeThread = Pick<
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

export interface CirceHomeSummary<T extends HomeThread> {
  /** Tasks waiting on the user, newest first. */
  readonly needs: ReadonlyArray<T>;
  /** Tasks a provider is working on right now, newest first. */
  readonly running: ReadonlyArray<T>;
  readonly completedToday: number;
  /** When the summary was taken, so relative ages agree with it. */
  readonly at: number;
}

const RUNNING_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

function sameLocalDay(iso: string, now: Date): boolean {
  const date = new Date(iso);
  return (
    !Number.isNaN(date.getTime()) &&
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/**
 * What the home screen reads: work that needs the user, work that is running,
 * and how much finished today. Subagents live inside their parent task and
 * are not counted twice. Mirrors the web overview's summary.
 */
export function summarizeCirceHome<T extends HomeThread>(
  threads: ReadonlyArray<T>,
  now: Date,
): CirceHomeSummary<T> {
  const needs: T[] = [];
  const running: T[] = [];
  let completedToday = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (thread.lineage.relationshipToParent === "subagent") continue;
    if (thread.hasPendingApprovals || thread.hasPendingUserInput) needs.push(thread);
    else if (thread.runtime !== null && RUNNING_STATUSES.has(thread.runtime.status))
      running.push(thread);
    const completedAt = thread.latestRun?.completedAt;
    if (thread.latestRun?.status === "completed" && completedAt && sameLocalDay(completedAt, now))
      completedToday += 1;
  }
  const newestFirst = (left: T, right: T) => right.updatedAt.localeCompare(left.updatedAt);
  // Hermes has no Array#toSorted; these arrays are local, so sort in place.
  needs.sort(newestFirst);
  running.sort(newestFirst);
  return { needs, running, completedToday, at: now.getTime() };
}

const COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/**
 * The line under the greeting: what needs the user first, then what is
 * running, naming the machine when all the running work is on one.
 */
export function circeHomeStatusLine(input: {
  readonly needs: number;
  readonly running: number;
  readonly runningMachine: string | null;
}): { readonly attention: string | null; readonly rest: string } {
  const count = (n: number) => COUNT_WORDS[n] ?? String(n);
  const attention =
    input.needs > 0
      ? `${count(input.needs)} task${input.needs === 1 ? " needs" : "s need"} you.`
      : null;
  if (input.running === 0) {
    return { attention, rest: attention ? "" : "Nothing needs you." };
  }
  const where = input.runningMachine
    ? `${input.runningMachine} is running`
    : "Your machines are running";
  const number = count(input.running).toLowerCase();
  return {
    attention,
    rest: attention
      ? `${where} ${number} more.`
      : `${where} ${number} ${input.running === 1 ? "task" : "tasks"}.`,
  };
}
