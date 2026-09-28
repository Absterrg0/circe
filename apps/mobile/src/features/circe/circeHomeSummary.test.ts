import { describe, expect, it } from "vite-plus/test";

import { circeHomeStatusLine, summarizeCirceHome } from "./circeHomeSummary";

type Thread = Parameters<typeof summarizeCirceHome>[0][number];

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

describe("Circe mobile home summary", () => {
  it("separates work that needs the user from running work, newest first", () => {
    const summary = summarizeCirceHome(
      [
        thread({
          id: "old-approval",
          hasPendingApprovals: true,
          updatedAt: "2026-09-28T08:00:00Z",
        }),
        thread({
          id: "new-question",
          hasPendingUserInput: true,
          updatedAt: "2026-09-28T12:00:00Z",
        }),
        thread({ id: "running", runtime: { status: "running" } }),
        thread({ id: "queued", runtime: { status: "queued" } }),
        thread({ id: "idle", runtime: { status: "idle" } }),
        thread({
          id: "done",
          latestRun: {
            status: "completed",
            completedAt: new Date(NOW.getTime() - 60_000).toISOString(),
          },
        }),
        thread({ id: "archived", hasPendingApprovals: true, archivedAt: "2026-09-28T01:00:00Z" }),
        thread({
          id: "child",
          runtime: { status: "running" },
          lineage: { relationshipToParent: "subagent" },
        }),
      ],
      NOW,
    );
    expect(summary.needs.map((entry) => entry.id)).toEqual(["new-question", "old-approval"]);
    expect(summary.running.map((entry) => entry.id).toSorted()).toEqual(["queued", "running"]);
    expect(summary.completedToday).toBe(1);
  });

  it("leads with what needs the user and names the machine doing the rest", () => {
    expect(circeHomeStatusLine({ needs: 2, running: 2, runningMachine: "forge" })).toEqual({
      attention: "Two tasks need you.",
      rest: "forge is running two more.",
    });
    expect(circeHomeStatusLine({ needs: 0, running: 1, runningMachine: null })).toEqual({
      attention: null,
      rest: "Your machines are running one task.",
    });
    expect(circeHomeStatusLine({ needs: 1, running: 0, runningMachine: null })).toEqual({
      attention: "One task needs you.",
      rest: "",
    });
    expect(circeHomeStatusLine({ needs: 0, running: 0, runningMachine: null })).toEqual({
      attention: null,
      rest: "Nothing needs you.",
    });
  });
});
