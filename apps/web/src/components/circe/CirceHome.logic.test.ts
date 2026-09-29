import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@circe/contracts";
import type { ThreadRuntimeSummary } from "@circe/client/state/models";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import { buildCirceHomeTasks, countCirceTasksNeedingYou, greetingForHour } from "./CirceHome.logic";

const NODE = EnvironmentId.make("laptop");
const CODE = ProjectId.make("code");
const CHATS = ProjectId.make("chats");
const NOW = "2026-09-29T12:00:00.000Z";

const workspaceByKey = new Map([
  [`${NODE}:${CODE}`, { title: "circe" }],
  [`${NODE}:${CHATS}`, { title: "Chats", kind: "chats" as const }],
]);

function thread(id: string, overrides: ThreadFixtureOverrides = {}) {
  return makeThreadFixture({
    environmentId: NODE,
    projectId: CODE,
    id: ThreadId.make(id),
    runtime: null,
    updatedAt: "2026-09-29T10:00:00.000Z",
    ...overrides,
  });
}

function runtime(status: "running" | "failed"): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: null,
    lastError: null,
    updatedAt: "2026-09-29T09:00:00.000Z",
  };
}

function ids(tasks: ReadonlyArray<{ readonly thread: { readonly id: string } }>) {
  return tasks.map((task) => task.thread.id);
}

describe("buildCirceHomeTasks", () => {
  it("sorts work into needs-you, running, and recent with the sidebar's status rules", () => {
    const tasks = buildCirceHomeTasks({
      threads: [
        thread("approval", { hasPendingApprovals: true }),
        thread("question", { hasPendingUserInput: true, updatedAt: "2026-09-29T11:00:00.000Z" }),
        thread("broken", { runtime: runtime("failed") }),
        thread("busy", { runtime: runtime("running") }),
        thread("done"),
      ],
      workspaceByKey,
      now: NOW,
    });

    expect(ids(tasks.needsYou)).toEqual(["question", "approval", "broken"]);
    expect(ids(tasks.running)).toEqual(["busy"]);
    expect(ids(tasks.recent)).toEqual(["done"]);
    expect(tasks.running[0]?.projectTitle).toBe("circe");
  });

  it("keeps parked work off the attention list and hides archived and subagent threads", () => {
    const tasks = buildCirceHomeTasks({
      threads: [
        thread("settled", { hasPendingUserInput: true, settledOverride: "settled" }),
        // Snoozed after it failed: the user already saw it.
        thread("snoozed", {
          runtime: runtime("failed"),
          snoozedAt: "2026-09-29T11:00:00.000Z",
          snoozedUntil: "2026-09-30T00:00:00.000Z",
        }),
        // A new approval wakes a snoozed thread, as in the sidebar.
        thread("raised-hand", {
          hasPendingApprovals: true,
          snoozedUntil: "2026-09-30T00:00:00.000Z",
        }),
        thread("archived", { archivedAt: "2026-09-28T00:00:00.000Z" }),
        thread("child", {
          lineage: {
            rootThreadId: ThreadId.make("root"),
            parentThreadId: ThreadId.make("root"),
            relationshipToParent: "subagent",
          },
        }),
      ],
      workspaceByKey,
      now: NOW,
    });

    expect(ids(tasks.needsYou)).toEqual(["raised-hand"]);
    expect(ids(tasks.recent).toSorted()).toEqual(["settled", "snoozed"]);
  });

  it("counts the same needs-you threads the sidebar badge shows", () => {
    const threads = [
      thread("approval", { hasPendingApprovals: true }),
      thread("settled", { hasPendingUserInput: true, settledOverride: "settled" }),
      thread("busy", { runtime: runtime("running") }),
      thread("done"),
    ];
    const { needsYou } = buildCirceHomeTasks({ threads, workspaceByKey, now: NOW });
    expect(countCirceTasksNeedingYou({ threads, now: NOW })).toBe(needsYou.length);
    expect(needsYou.length).toBe(1);
  });

  it("marks chats and does not give them a project title", () => {
    const [chat] = buildCirceHomeTasks({
      threads: [thread("chat", { projectId: CHATS })],
      workspaceByKey,
      now: NOW,
    }).recent;

    expect(chat).toMatchObject({ isChat: true, projectTitle: null });
  });

  it("caps recent work at six rows", () => {
    const threads = Array.from({ length: 9 }, (_, index) =>
      thread(`t${index}`, { updatedAt: `2026-09-29T0${index}:00:00.000Z` }),
    );
    const { recent } = buildCirceHomeTasks({ threads, workspaceByKey, now: NOW });
    expect(ids(recent)).toEqual(["t8", "t7", "t6", "t5", "t4", "t3"]);
  });
});

describe("greetingForHour", () => {
  it("follows the time of day", () => {
    expect(greetingForHour(3)).toBe("Working late");
    expect(greetingForHour(9)).toBe("Good morning");
    expect(greetingForHour(14)).toBe("Good afternoon");
    expect(greetingForHour(21)).toBe("Good evening");
  });
});
