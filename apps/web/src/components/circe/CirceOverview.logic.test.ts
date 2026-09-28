import { describe, expect, it } from "vite-plus/test";

import {
  formatRunDuration,
  overviewAttentionLine,
  overviewTaskState,
  summarizeCirceOverview,
} from "./CirceOverview.logic";
import { railNodeMonogram } from "./CirceRail";

type Thread = Parameters<typeof summarizeCirceOverview>[0][number];

const NOW = new Date("2026-09-28T18:00:00");

function thread(overrides: { readonly id: string } & Readonly<Record<string, unknown>>): Thread {
  return {
    environmentId: "forge",
    projectId: "api",
    title: overrides.id,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-09-28T10:00:00.000Z",
    latestRun: null,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    lineage: { relationshipToParent: null },
    ...overrides,
  } as unknown as Thread;
}

const run = (status: string, completedAt: string | null) =>
  ({ runId: "r", status, requestedAt: null, startedAt: null, completedAt }) as Thread["latestRun"];

describe("Circe overview summary", () => {
  it("counts work in the fixed status vocabulary and lists what needs the user, newest first", () => {
    const summary = summarizeCirceOverview(
      [
        thread({ id: "approval", hasPendingApprovals: true, updatedAt: "2026-09-28T09:00:00Z" }),
        thread({ id: "question", hasPendingUserInput: true, updatedAt: "2026-09-28T11:00:00Z" }),
        thread({ id: "running", runtime: { status: "running" } as Thread["runtime"] }),
        thread({ id: "failed", runtime: { status: "failed" } as Thread["runtime"] }),
        thread({
          id: "done-today",
          latestRun: run("completed", new Date(NOW.getTime() - 3_600_000).toISOString()),
        }),
        thread({ id: "done-before", latestRun: run("completed", "2026-09-20T10:00:00Z") }),
        thread({ id: "archived", hasPendingApprovals: true, archivedAt: "2026-09-28T01:00:00Z" }),
        thread({
          id: "subagent",
          hasPendingApprovals: true,
          lineage: { relationshipToParent: "subagent" } as Thread["lineage"],
        }),
      ],
      NOW,
    );

    expect(summary.needs.map((entry) => entry.id)).toEqual(["question", "approval"]);
    expect(summary.running).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.completedToday).toBe(1);
  });

  it("maps a thread to one status word", () => {
    expect(overviewTaskState(thread({ id: "a", hasPendingApprovals: true }))).toBe("needs");
    expect(
      overviewTaskState(thread({ id: "b", runtime: { status: "waiting" } as Thread["runtime"] })),
    ).toBe("running");
    expect(
      overviewTaskState(thread({ id: "c", runtime: { status: "idle" } as Thread["runtime"] })),
    ).toBe("queued");
    expect(overviewTaskState(thread({ id: "d", latestRun: run("completed", null) }))).toBe("done");
    expect(overviewTaskState(thread({ id: "e" }))).toBe("settled");
  });

  it("says what needs the user before what is running", () => {
    expect(overviewAttentionLine(2, 3)).toEqual({ text: "Two tasks need you.", tone: "attention" });
    expect(overviewAttentionLine(1, 0)).toEqual({ text: "One task needs you.", tone: "attention" });
    expect(overviewAttentionLine(0, 1)).toEqual({ text: "One task is running.", tone: "ember" });
    expect(overviewAttentionLine(0, 12)).toEqual({ text: "12 tasks are running.", tone: "ember" });
    expect(overviewAttentionLine(0, 0)).toEqual({ text: "Nothing needs you.", tone: "quiet" });
  });

  it("formats elapsed work time and refuses impossible ranges", () => {
    const start = "2026-09-28T17:00:00.000Z";
    expect(formatRunDuration(start, "2026-09-28T17:00:48.000Z", NOW)).toBe("48s");
    expect(formatRunDuration(start, "2026-09-28T17:06:12.000Z", NOW)).toBe("6m 12s");
    expect(formatRunDuration(start, "2026-09-28T18:04:00.000Z", NOW)).toBe("1h 04m");
    expect(formatRunDuration(start, "2026-09-28T16:00:00.000Z", NOW)).toBeNull();
    expect(formatRunDuration(null, null, NOW)).toBeNull();
  });
});

describe("rail machine tiles", () => {
  it("labels a machine with the first two characters of its lowercase name", () => {
    expect(railNodeMonogram("forge")).toBe("fo");
    expect(railNodeMonogram("Pi-Lab")).toBe("pi");
    expect(railNodeMonogram("—")).toBe("?");
  });
});
