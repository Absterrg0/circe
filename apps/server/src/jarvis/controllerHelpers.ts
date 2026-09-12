import {
  type EnvironmentId,
  JarvisTaskCreatedActivityPayload,
  type JarvisRequestMetadata,
  type JarvisTaskDeskTask,
  type JarvisTaskRef,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  type JarvisCommandTask,
  type JarvisTaskNavigationCandidate,
} from "@t3tools/jarvis-core/command";
import {
  resolveJarvisClarificationChoice,
  resolveJarvisClarificationOrdinal,
} from "@t3tools/jarvis-core/clarification";
import { listPendingJarvisReplies } from "@t3tools/jarvis-core/confirmation";
import { deriveJarvisTaskState } from "@t3tools/jarvis-core/deriveTaskState";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeTaskCreatedPayload = Schema.decodeUnknownOption(JarvisTaskCreatedActivityPayload);

export function taskTitle(objective: string): string {
  const withoutTerminalPunctuation = objective.replace(/[.!?]+$/u, "");
  return withoutTerminalPunctuation.length <= 80
    ? withoutTerminalPunctuation
    : `${withoutTerminalPunctuation.slice(0, 79)}…`;
}

function modelSelectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const leftOptions = left.options ?? [];
  const rightOptions = right.options ?? [];
  if (leftOptions.length !== rightOptions.length) return false;
  return leftOptions.every((option) =>
    rightOptions.some(
      (candidate) => candidate.id === option.id && candidate.value === option.value,
    ),
  );
}

function requestMetadataMatch(
  left: JarvisRequestMetadata | undefined,
  right: JarvisRequestMetadata,
): boolean {
  if (left?.requestId !== right.requestId) return false;
  if (left.inputMode !== right.inputMode) return false;
  if (left.sourceUtterance !== right.sourceUtterance) return false;
  return (
    left.origin?.originNodeId === right.origin?.originNodeId &&
    left.origin?.originInteractionId === right.origin?.originInteractionId
  );
}

function taskCreatedPayload(thread: OrchestrationThread) {
  const marker = thread.activities.findLast((activity) => activity.kind === "jarvis.task.created");
  return marker === undefined
    ? undefined
    : Option.getOrUndefined(decodeTaskCreatedPayload(marker.payload));
}

export function routedThreadMatches(input: {
  readonly thread: OrchestrationThread;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly objective: string;
  readonly modelSelection: ModelSelection;
  readonly requestMetadata: JarvisRequestMetadata;
}): boolean {
  if (
    input.thread.projectId !== input.projectId ||
    !modelSelectionsMatch(input.thread.modelSelection, input.modelSelection)
  ) {
    return false;
  }
  const marker = input.thread.activities.findLast(
    (activity) => activity.kind === "jarvis.task.created",
  );
  if (marker === undefined) return input.thread.title === input.title;
  const payload = Option.getOrUndefined(decodeTaskCreatedPayload(marker.payload));
  return (
    payload !== undefined &&
    payload.objective === input.objective &&
    requestMetadataMatch(payload.requestMetadata, input.requestMetadata)
  );
}

export function taskRefFor(
  executionNodeId: EnvironmentId | undefined,
  threadId: ThreadId,
): JarvisTaskRef | undefined {
  return executionNodeId === undefined ? undefined : { executionNodeId, threadId };
}

export const normalizeTaskDeskAnswer = (utterance: string): string =>
  utterance
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/u, "");

/** Task ordinal via the shared clarification parser (first one, option, number). */
export const ordinalTaskChoice = (answer: string): number | undefined =>
  resolveJarvisClarificationOrdinal(answer);

const SUPERVISOR_REFUSAL_PATTERN =
  /usage limit|quota|rate.?limit|too many requests|unauthorized|unauthenticated|forbidden|sign.?in|not authenticated|invalid api key|\b401\b|\b403\b|\b429\b/iu;

function supervisorFailureText(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(cause);
}

/**
 * User-facing prompt for a failed semantic-supervisor call. A provider
 * refusal (quota, auth) names the supervisor instance and the refusal so
 * the message is actionable; every other failure keeps the generic prompt
 * instead of leaking CLI output into speech.
 */
export function jarvisSupervisorFallbackPrompt(input: {
  readonly instanceId: string;
  readonly cause: unknown;
}): string {
  if (SUPERVISOR_REFUSAL_PATTERN.test(supervisorFailureText(input.cause))) {
    return (
      `The ${input.instanceId} supervisor refused the request (usage limit or sign-in). ` +
      `Check the provider and try again.`
    );
  }
  return "Jarvis couldn't interpret that request safely. Check the semantic supervisor and try again.";
}

function basenameLower(value: string): string | undefined {
  const base = value.split("/").filter((part) => part.length > 0).pop();
  return base === undefined || base.length === 0 ? undefined : base;
}

/**
 * Answer a pending project clarification by spoken name. Ordinals are tried
 * first by the caller; this resolves an unambiguous bare project name (the
 * natural one-word voice answer) against the live catalog, including the
 * repository name behind a title that differs. Ambiguous names and new
 * instructions stay unmatched so the pending route is kept.
 */
export function projectClarificationChoiceIndex(input: {
  readonly candidates: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly label: string;
    readonly learnedAlias?: string | undefined;
  }>;
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly title: string;
    readonly workspaceRoot?: string | undefined;
    readonly repositoryIdentity?:
      | {
          readonly name?: string | null | undefined;
          readonly displayName?: string | null | undefined;
        }
      | null
      | undefined;
  }>;
  readonly answer: string;
}): number | undefined {
  const views = input.candidates.map((candidate) => {
    const project = input.projects.find((entry) => entry.id === candidate.projectId);
    const extra: Array<string> = [];
    if (project !== undefined) {
      const base = project.workspaceRoot === undefined ? undefined : basenameLower(project.workspaceRoot);
      if (base !== undefined) extra.push(base);
      const repoName = project.repositoryIdentity?.name;
      if (typeof repoName === "string" && repoName.trim().length > 0) extra.push(repoName);
      const displayName = project.repositoryIdentity?.displayName;
      if (typeof displayName === "string" && displayName.trim().length > 0) extra.push(displayName);
    }
    return {
      label: candidate.label,
      names: [
        candidate.label,
        ...(project === undefined ? [] : [project.title, ...extra]),
        ...(candidate.learnedAlias === undefined ? [] : [candidate.learnedAlias]),
      ],
    };
  });
  const choice = resolveJarvisClarificationChoice(views, input.answer);
  return choice === undefined ? undefined : views.indexOf(choice);
}

export function commandTaskFromThread(input: {
  readonly thread: OrchestrationThread;
  readonly projectTitle: string;
  readonly executionNodeId?: EnvironmentId;
  readonly queuedFollowUps?: number;
}): JarvisCommandTask {
  const marker = taskCreatedPayload(input.thread);
  const pendings = listPendingJarvisReplies(input.thread.activities);
  const taskRef = marker?.taskRef ?? taskRefFor(input.executionNodeId, input.thread.id);
  return {
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    projectTitle: input.projectTitle,
    title: input.thread.title,
    objective:
      marker?.objective ??
      input.thread.messages.find((message) => message.role === "user")?.text.trim() ??
      input.thread.title,
    state: deriveJarvisTaskState({
      latestTurn: input.thread.latestTurn,
      session: input.thread.session,
      hasPendingApprovals: pendings.some((pending) => pending.kind === "approval"),
      hasPendingUserInput: pendings.some((pending) => pending.kind === "user-input"),
    }),
    ...(input.queuedFollowUps === undefined || input.queuedFollowUps === 0
      ? {}
      : { queuedFollowUps: input.queuedFollowUps }),
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(taskRef === undefined
      ? {}
      : { projectRef: { nodeId: taskRef.executionNodeId, projectId: input.thread.projectId } }),
  };
}

function navigationCandidateFromShell(input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly latestTurn: OrchestrationThread["latestTurn"];
    readonly session: OrchestrationThread["session"];
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
  };
  readonly executionNodeId?: EnvironmentId;
  readonly taskRef?: JarvisTaskRef;
}): JarvisTaskNavigationCandidate {
  const taskRef = input.taskRef ?? taskRefFor(input.executionNodeId, input.thread.id);
  return {
    threadId: input.thread.id,
    title: input.thread.title,
    objective: input.thread.title,
    state: deriveJarvisTaskState(input.thread),
    projectId: input.thread.projectId,
    ...(taskRef === undefined ? {} : { taskRef }),
  };
}

export function navigationCandidateFromDesk(
  task: JarvisTaskDeskTask,
  liveThread?: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly latestTurn: OrchestrationThread["latestTurn"];
    readonly session: OrchestrationThread["session"];
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
  },
): JarvisTaskNavigationCandidate | null {
  if (liveThread === undefined) return null;
  return navigationCandidateFromShell({
    thread: liveThread,
    taskRef: task.taskRef,
    executionNodeId: task.taskRef.executionNodeId,
  });
}

/**
 * Command-task view from lightweight shell data. Navigation, matching, and
 * clarification labels run on this; the selected task's full detail is
 * reloaded before execution, so the objective shown for unselected tasks
 * falls back to the shell title instead of hydrating every recent thread.
 */
export function commandTaskFromShell(input: {
  readonly thread: OrchestrationThreadShell;
  readonly projectTitle: string;
  readonly executionNodeId?: EnvironmentId;
  readonly taskRef?: JarvisTaskRef;
  readonly queuedFollowUps?: number;
}): JarvisCommandTask {
  const taskRef = input.taskRef ?? taskRefFor(input.executionNodeId, input.thread.id);
  return {
    threadId: input.thread.id,
    projectId: input.thread.projectId,
    projectTitle: input.projectTitle,
    title: input.thread.title,
    objective: input.thread.title,
    state: deriveJarvisTaskState(input.thread),
    ...(input.queuedFollowUps === undefined || input.queuedFollowUps === 0
      ? {}
      : { queuedFollowUps: input.queuedFollowUps }),
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(taskRef === undefined
      ? {}
      : { projectRef: { nodeId: taskRef.executionNodeId, projectId: input.thread.projectId } }),
  };
}
