import {
  choiceAnswer,
  noulHolds,
  type DecisionAnswers,
  type DecisionRequest,
} from "../decision.ts";
import { NONE_OPTION } from "../toolRegistry.ts";

/**
 * Experiment: "what needs me right now?" as a finite decision.
 *
 * There is no aggregate attention view today. The task desk is a bounded
 * recent list ordered by last focus, status is single-task template speech,
 * and push fires one generic notification per event. So a backlog of ten
 * tasks produces ten identical buzzes in focus order, not urgency order.
 *
 * Code ranks every task by typed state first (the band), then the model picks
 * the lead from the actionable set. If the model's pick disagrees with the
 * top band, code keeps its own lead; the model only ever breaks ties or
 * phrases the reason.
 */

export type CirceTaskAttentionState =
  | "running"
  | "waiting-for-input"
  | "waiting-for-approval"
  | "ready"
  | "failed"
  | "interrupted"
  | "unknown";

export type AttentionReason =
  | "approval"
  | "question"
  | "failure"
  | "finished-unseen"
  | "queue-blocked"
  | "running"
  | "nothing";

export interface AttentionTask {
  /** Human-readable name used as the option key. No internal IDs. */
  readonly key: string;
  readonly state: CirceTaskAttentionState;
  readonly queuedFollowUps?: number;
  readonly stale?: boolean;
  readonly snoozed?: boolean;
  readonly unreadResult?: boolean;
  readonly approvalDestructive?: boolean;
  readonly nodeDisconnected?: boolean;
}

const BAND: Readonly<Record<CirceTaskAttentionState, number>> = {
  "waiting-for-approval": 6,
  "waiting-for-input": 5,
  failed: 4,
  ready: 3,
  interrupted: 2,
  running: 2,
  unknown: 1,
};

export function attentionBand(task: AttentionTask): number {
  if (task.snoozed === true) return 0;
  return BAND[task.state] ?? 1;
}

export function attentionReason(task: AttentionTask): AttentionReason {
  switch (task.state) {
    case "waiting-for-approval":
      return "approval";
    case "waiting-for-input":
      return "question";
    case "failed":
      return "failure";
    case "ready":
      return task.unreadResult === true
        ? "finished-unseen"
        : (task.queuedFollowUps ?? 0) > 0
          ? "queue-blocked"
          : "nothing";
    case "running":
    case "interrupted":
      return "running";
    default:
      return "nothing";
  }
}

/** Actionable tasks in code-ranked order: highest band first, then queue depth. */
export function rankedAttentionTasks(tasks: ReadonlyArray<AttentionTask>): ReadonlyArray<{
  readonly task: AttentionTask;
  readonly band: number;
  readonly reason: AttentionReason;
}> {
  return [...tasks]
    .map((task) => ({ task, band: attentionBand(task), reason: attentionReason(task) }))
    .sort((left, right) => {
      if (right.band !== left.band) return right.band - left.band;
      return (right.task.queuedFollowUps ?? 0) - (left.task.queuedFollowUps ?? 0);
    });
}

const REASONS: ReadonlyArray<AttentionReason> = [
  "approval",
  "question",
  "failure",
  "finished-unseen",
  "queue-blocked",
  "running",
  "nothing",
];

const REASON_CRITERIA: Readonly<Record<AttentionReason, string>> = {
  approval: "A destructive or standing request is waiting for a yes or no.",
  question: "The agent asked the user something and is blocked.",
  failure: "The task failed and may need a retry.",
  "finished-unseen": "Work finished and the user has not seen the result.",
  "queue-blocked": "A follow-up is queued but the task is not ready for it.",
  running: "Work is still running; nothing is blocked on the user.",
  nothing: "No task needs the user.",
};

const choice = (
  instructions: string,
  criteria: Record<string, string | null>,
): DecisionRequest["questions"][string] => ({ type: "choice", instructions, criteria });

export function buildAttentionDecisionRequest(input: {
  readonly tasks: ReadonlyArray<AttentionTask>;
}): DecisionRequest {
  const taskCriteria: Record<string, string | null> = {};
  for (const task of input.tasks) {
    taskCriteria[task.key] = [
      task.state,
      (task.queuedFollowUps ?? 0) > 0 ? `${task.queuedFollowUps} queued` : undefined,
      task.stale === true ? "stale" : undefined,
      task.nodeDisconnected === true ? "node offline" : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(", ");
  }
  taskCriteria[NONE_OPTION] = "No task needs the user.";

  const reasonCriteria: Record<string, string | null> = {};
  for (const reason of REASONS) reasonCriteria[reason] = REASON_CRITERIA[reason];

  return {
    state: { tasks: input.tasks },
    model: "jev-latest",
    questions: {
      lead_task: choice("Which single task most needs the user right now?", taskCriteria),
      lead_reason: choice("Why does that task need the user?", reasonCriteria),
      needs_user: {
        type: "noul",
        instructions: "Does any task need the user before work can continue?",
        criteria: {
          true: "At least one task is blocked on the user.",
          false: "Nothing is blocked on the user.",
        },
      },
    },
  };
}

export type AttentionBriefing =
  | { readonly status: "clear"; readonly line: string }
  | {
      readonly status: "briefing";
      readonly lead: AttentionTask;
      readonly reason: AttentionReason;
      readonly line: string;
    };

/** Speech composed only from typed state, never from model text. */
export function composeBriefingLine(task: AttentionTask, reason: AttentionReason): string {
  const queued =
    (task.queuedFollowUps ?? 0) > 0
      ? ` ${task.queuedFollowUps} follow-up${task.queuedFollowUps === 1 ? " is" : "s are"} queued.`
      : "";
  const offline = task.nodeDisconnected === true ? " Its node is offline." : "";
  switch (reason) {
    case "approval":
      return task.approvalDestructive === true
        ? `${task.key} is waiting for approval on a destructive request.`
        : `${task.key} is waiting for your approval.`;
    case "question":
      return `${task.key} asked you a question and is waiting.`;
    case "failure":
      return `${task.key} failed and may need a retry.`;
    case "finished-unseen":
      return `${task.key} finished.${queued}${offline}`;
    case "queue-blocked":
      return `${task.key} has a follow-up queued but is not ready for it yet.${offline}`;
    case "running":
      return `${task.key} is still running.${queued}`;
    case "nothing":
      return "Nothing needs you right now.";
  }
}

/**
 * Compose the briefing. `none` or a non-actionable answer is clear. A model
 * pick below the top code band is overridden, so the lead is never a running
 * task while an approval waits.
 */
export function composeAttentionBriefing(input: {
  readonly tasks: ReadonlyArray<AttentionTask>;
  readonly answers: DecisionAnswers;
}): AttentionBriefing {
  const ranked = rankedAttentionTasks(input.tasks);
  const actionable = ranked.filter((entry) => entry.band >= 3 && entry.reason !== "nothing");
  if (actionable.length === 0) {
    return { status: "clear", line: "Nothing needs you right now." };
  }

  const needsUser = noulHolds(input.answers, "needs_user", 0.5);
  const selectedKey = choiceAnswer(input.answers, "lead_task")?.choice;
  if (needsUser === false && (selectedKey === undefined || selectedKey === NONE_OPTION)) {
    return { status: "clear", line: "Nothing needs you right now." };
  }

  const top = actionable[0]!;
  const modelPick = ranked.find((entry) => entry.task.key === selectedKey);
  const lead = modelPick !== undefined && modelPick.band >= top.band ? modelPick : top;
  const reasonAnswer = choiceAnswer(input.answers, "lead_reason")?.choice as
    | AttentionReason
    | undefined;
  const reason =
    modelPick !== undefined && modelPick.band >= top.band && reasonAnswer !== undefined
      ? reasonAnswer
      : lead.reason;
  return {
    status: "briefing",
    lead: lead.task,
    reason,
    line: composeBriefingLine(lead.task, reason),
  };
}
