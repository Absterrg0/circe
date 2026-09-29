import type { EnvironmentThreadShell } from "@circe/client/state/models";
import { effectiveSnoozed } from "@circe/client/state/thread-settled";
import {
  isChatWorkspace,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
  type WorkspaceKind,
} from "@circe/contracts";

import {
  filterSidebarV2VisibleThreads,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

export interface CirceHomeTask {
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
  /** Project title, or null for a chat or a workspace that has not loaded. */
  readonly projectTitle: string | null;
  readonly isChat: boolean;
}

export interface CirceHomeTasks {
  /** Waiting on the user: an approval, a question, or a failed run. */
  readonly needsYou: ReadonlyArray<CirceHomeTask>;
  readonly running: ReadonlyArray<CirceHomeTask>;
  /** The latest settled-down work, newest first. */
  readonly recent: ReadonlyArray<CirceHomeTask>;
}

const RECENT_LIMIT = 6;

function isNeedsYou(status: SidebarThreadStatus): boolean {
  return status === "approval" || status === "input" || status === "failed";
}

function isRunning(status: SidebarThreadStatus): boolean {
  return status === "working" || status === "waiting";
}

function newestFirst(left: CirceHomeTask, right: CirceHomeTask): number {
  return right.thread.updatedAt.localeCompare(left.thread.updatedAt);
}

type CirceHomeBucket = "needsYou" | "running" | "recent";

function bucketOf(
  thread: EnvironmentThreadShell,
  status: SidebarThreadStatus,
  now: string,
): CirceHomeBucket {
  if (isRunning(status)) return "running";
  const parked = thread.settledOverride === "settled" || effectiveSnoozed(thread, { now });
  return isNeedsYou(status) && !parked ? "needsYou" : "recent";
}

/** How many threads wait on the user, for the Home badge in the sidebar. */
export function countCirceTasksNeedingYou(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: string;
}): number {
  let count = 0;
  for (const thread of filterSidebarV2VisibleThreads(input.threads, null)) {
    if (bucketOf(thread, resolveSidebarThreadStatus(thread), input.now) === "needsYou") count += 1;
  }
  return count;
}

/**
 * Sort every visible thread into what Home shows. Uses the sidebar's status
 * rules so a thread never reads "needs you" on one screen and "done" on the
 * other. Threads the user parked (settled, or snoozed until later) stay off
 * the attention lists; they still count as recent.
 */
export function buildCirceHomeTasks(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly workspaceByKey: ReadonlyMap<
    string,
    { readonly title: string; readonly kind?: WorkspaceKind | undefined }
  >;
  readonly now: string;
}): CirceHomeTasks {
  const needsYou: CirceHomeTask[] = [];
  const running: CirceHomeTask[] = [];
  const recent: CirceHomeTask[] = [];
  for (const thread of filterSidebarV2VisibleThreads(input.threads, null)) {
    const workspace = input.workspaceByKey.get(`${thread.environmentId}:${thread.projectId}`);
    const isChat = workspace !== undefined && isChatWorkspace(workspace);
    const task: CirceHomeTask = {
      thread,
      status: resolveSidebarThreadStatus(thread),
      projectTitle: isChat ? null : (workspace?.title ?? null),
      isChat,
    };
    const bucket = bucketOf(thread, task.status, input.now);
    if (bucket === "running") running.push(task);
    else if (bucket === "needsYou") needsYou.push(task);
    else recent.push(task);
  }
  return {
    needsYou: needsYou.toSorted(newestFirst),
    running: running.toSorted(newestFirst),
    recent: recent.toSorted(newestFirst).slice(0, RECENT_LIMIT),
  };
}

/** Plain time-of-day greeting for the Home header. */
export function greetingForHour(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Where a pull request stands, in the order a reviewer would act on it. */
export type CirceHomePullRequestReadiness = "failing" | "changes" | "ready" | "review" | "draft";

export function pullRequestReadiness(
  snapshot: ThreadPullRequestSnapshot,
): CirceHomePullRequestReadiness {
  if (snapshot.isDraft) return "draft";
  if (snapshot.checksState === "failing" || snapshot.mergeability === "conflicting") {
    return "failing";
  }
  if (snapshot.reviewDecision === "changes-requested") return "changes";
  if (snapshot.reviewDecision === "approved" && snapshot.checksState !== "pending") return "ready";
  return "review";
}

export interface CirceHomePullRequest {
  readonly key: string;
  readonly link: ThreadPullRequestLink & { readonly snapshot: ThreadPullRequestSnapshot };
  readonly readiness: CirceHomePullRequestReadiness;
  /** The newest thread that links it; opening the row opens that thread. */
  readonly thread: EnvironmentThreadShell;
}

const PULL_REQUEST_LIMIT = 4;

/**
 * Open pull requests that agents opened or the user linked, from the synced
 * snapshots already on thread shells. Home never queries the host itself; a
 * link that has not synced yet has no title to show and waits for its sync.
 */
export function collectCirceHomePullRequests(threads: ReadonlyArray<EnvironmentThreadShell>): {
  readonly total: number;
  readonly items: ReadonlyArray<CirceHomePullRequest>;
} {
  const byKey = new Map<string, CirceHomePullRequest>();
  for (const thread of filterSidebarV2VisibleThreads(threads, null)) {
    for (const link of thread.pullRequests) {
      const snapshot = link.snapshot;
      if (link.source === "stack-dismissed" || snapshot === null || snapshot.state !== "open") {
        continue;
      }
      const key = `${link.host}/${link.repository}#${link.number}`;
      const existing = byKey.get(key);
      if (existing !== undefined && existing.thread.updatedAt >= thread.updatedAt) continue;
      byKey.set(key, {
        key,
        link: { ...link, snapshot },
        readiness: pullRequestReadiness(snapshot),
        thread,
      });
    }
  }
  const sorted = [...byKey.values()].toSorted((left, right) =>
    (right.link.snapshot.updatedAt ?? right.link.linkedAt).localeCompare(
      left.link.snapshot.updatedAt ?? left.link.linkedAt,
    ),
  );
  return { total: sorted.length, items: sorted.slice(0, PULL_REQUEST_LIMIT) };
}

/** Read the minute clock (`YYYY-MM-DDTHH:MM`, UTC) or a full ISO timestamp. */
function parseInstant(value: string): number {
  return Date.parse(value.length === 16 ? `${value}:00.000Z` : value);
}

/** Compact elapsed time for a running task: "now", "12m", "1h 5m", "3d". */
export function formatElapsed(startedAt: string, now: string): string {
  const minutes = Math.max(0, Math.floor((parseInstant(now) - parseInstant(startedAt)) / 60_000));
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
