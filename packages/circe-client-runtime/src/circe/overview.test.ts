import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@circe/contracts";
import type { CirceTaskDeskTaskView } from "@circe/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildCirceNeedsAttention, circeNeedsAttentionIsEmpty } from "./overview.ts";

const projectRef = {
  nodeId: EnvironmentId.make("node-1"),
  projectId: ProjectId.make("project-1"),
};

const task = (
  id: string,
  state: CirceTaskDeskTaskView["state"],
  pendingReply?: CirceTaskDeskTaskView["pendingReply"],
): CirceTaskDeskTaskView => ({
  threadId: ThreadId.make(id),
  taskRef: { executionNodeId: projectRef.nodeId, threadId: ThreadId.make(id) },
  projectRef,
  title: `Task ${id}`,
  objective: "Do the thing",
  state,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  ...(pendingReply === undefined ? {} : { pendingReply }),
});

const desk = (
  focusedTask: CirceTaskDeskTaskView | null,
  recentTasks: ReadonlyArray<CirceTaskDeskTaskView>,
  pendingInteraction: Parameters<typeof buildCirceNeedsAttention>[0]["pendingInteraction"] = null,
): Parameters<typeof buildCirceNeedsAttention>[0] => ({
  focusedTask,
  recentTasks,
  pendingInteraction,
  updatedAt: null,
});

describe("circe needs attention", () => {
  it("is empty for a quiet desk", () => {
    const attention = buildCirceNeedsAttention(desk(task("a", "running"), []));
    expect(circeNeedsAttentionIsEmpty(attention)).toBe(true);
  });

  it("lists only tasks waiting on a person, once each", () => {
    const attention = buildCirceNeedsAttention(
      desk(null, [
        task("a", "waiting-for-approval"),
        task("b", "running"),
        task("c", "waiting-for-input"),
        task("d", "failed"),
        task("a", "waiting-for-approval"),
      ]),
    );
    expect(attention.tasks.map((entry) => [entry.threadId, entry.reason])).toEqual([
      ["a", "approval"],
      ["c", "input"],
      ["d", "failed"],
    ]);
  });

  it("prefers the live pending reply's kind over the lifecycle state", () => {
    const attention = buildCirceNeedsAttention(
      desk(null, [task("a", "waiting-for-input", { kind: "approval", requestId: "req-1" })]),
    );
    expect(attention.tasks[0]?.reason).toBe("approval");
  });

  it("projects the session's blocking frame with its prompt", () => {
    const attention = buildCirceNeedsAttention(
      desk(null, [], {
        kind: "lookup",
        frame: {
          frameId: "frame-1",
          originalUtterance: "what's the weather",
          lookupKind: "weather",
          day: "now",
          locationCandidates: [],
          previousPrompt: "Name the city.",
          createdAt: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
          expiresAt: DateTime.makeUnsafe("2026-08-12T00:05:00.000Z"),
        },
      }),
    );
    expect(attention.frame).toEqual({
      kind: "lookup",
      prompt: "Name the city.",
      frameId: "frame-1",
    });
  });
});
