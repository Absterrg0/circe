import type {
  CircePendingInteraction,
  CirceProjectRef,
  CirceTaskDeskTaskView,
  CirceTaskDeskView,
  CirceTaskRef,
  ThreadId,
} from "@circe/contracts";

/**
 * The desk as a "needs attention" list: the one blocking pending frame for the
 * session plus every task waiting for a person. This is a projection only; it
 * never carries answer authority, and it is derived from typed desk state, not
 * from feedback wording.
 */

export type CirceAttentionReason = "approval" | "input" | "failed";

export interface CirceAttentionTask {
  readonly threadId: ThreadId;
  readonly taskRef: CirceTaskRef;
  readonly projectRef: CirceProjectRef;
  readonly title: string;
  readonly reason: CirceAttentionReason;
}

export interface CircePendingAttention {
  readonly kind: CircePendingInteraction["kind"];
  readonly prompt: string;
  readonly frameId?: string;
}

export interface CirceNeedsAttention {
  /** The session's single blocking question, or null when none waits. */
  readonly frame: CircePendingAttention | null;
  /** Tasks waiting on a person, newest first, one row per task. */
  readonly tasks: ReadonlyArray<CirceAttentionTask>;
}

const framePrompt = (pending: CircePendingInteraction): string => {
  switch (pending.kind) {
    case "plan":
      return pending.frame.prompt;
    case "lookup":
    case "website":
      return pending.frame.previousPrompt;
    case "task":
      return "Choose which task you meant.";
    case "project":
      return "Choose which project you meant.";
  }
};

const pendingFrame = (pending: CircePendingInteraction): CircePendingAttention => ({
  kind: pending.kind,
  prompt: framePrompt(pending),
  ...(pending.frame.frameId === undefined ? {} : { frameId: pending.frame.frameId }),
});

const taskReason = (task: CirceTaskDeskTaskView): CirceAttentionReason | null => {
  const pending = task.pendingReply;
  if (pending !== undefined && pending !== null) {
    return pending.kind === "approval" ? "approval" : "input";
  }
  if (task.state === "waiting-for-approval") return "approval";
  if (task.state === "waiting-for-input") return "input";
  if (task.state === "failed") return "failed";
  return null;
};

export function buildCirceNeedsAttention(desk: CirceTaskDeskView): CirceNeedsAttention {
  const byThread = new Map<ThreadId, CirceAttentionTask>();
  for (const task of [desk.focusedTask, ...desk.recentTasks]) {
    if (task === null) continue;
    const reason = taskReason(task);
    if (reason === null || byThread.has(task.threadId)) continue;
    byThread.set(task.threadId, {
      threadId: task.threadId,
      taskRef: task.taskRef,
      projectRef: task.projectRef,
      title: task.title,
      reason,
    });
  }
  // Older payloads and test doubles may omit the field entirely.
  const pending = desk.pendingInteraction;
  return {
    frame: pending === null || pending === undefined ? null : pendingFrame(pending),
    tasks: [...byThread.values()],
  };
}

/** True when the desk has anything a person should look at. */
export function circeNeedsAttentionIsEmpty(attention: CirceNeedsAttention): boolean {
  return attention.frame === null && attention.tasks.length === 0;
}
