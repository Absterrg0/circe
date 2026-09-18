import {
  type CircePresentationEvent,
  type EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationV2ThreadProjection,
} from "@circe/contracts";

import {
  buildActivityPresentationForActivity,
  buildSessionPresentation,
  classifyActivityPresentationKind,
} from "@circe/core/buildPresentation";

/** Events that can change a Circe-owned task's user-facing state. */
export function isCircePresentationSource(event: OrchestrationEvent): boolean {
  if (event.type === "thread.session-set") return event.payload.session.status === "error";
  if (event.type !== "thread.activity-appended") return false;
  return classifyActivityPresentationKind(event.payload.activity) !== null;
}

/**
 * Adapt one already-projected T3 event into a short live presentation. The
 * task thread remains the source of truth. Returning null keeps ordinary T3
 * work and tasks without Circe origin metadata out of voice delivery.
 */
export function buildCircePresentation(
  event: OrchestrationEvent,
  thread: OrchestrationThread,
  projectTitle = "this project",
): CircePresentationEvent | null {
  if (event.type === "thread.activity-appended") {
    return buildActivityPresentationForActivity(thread, event.payload.activity, projectTitle);
  }
  if (event.type === "thread.session-set") {
    // ProviderRuntimeIngestion records the runtime error first and then
    // mirrors it onto the session read model. The activity is the live
    // presentation edge; suppress the derived session edge so one failure
    // cannot speak twice. Suppression requires the exact mirror: both the
    // turn and the message must correlate, so a different failure is never
    // silenced by an unrelated runtime error.
    const sessionTurnId = event.payload.session.activeTurnId;
    const sessionError = event.payload.session.lastError;
    const mirroredRuntimeError = thread.activities.some((activity) => {
      if (activity.kind !== "runtime.error") return false;
      const turnCorrelated =
        sessionTurnId === null ? activity.turnId === null : activity.turnId === sessionTurnId;
      const payload = activity.payload;
      const message =
        typeof payload === "object" && payload !== null && "message" in payload
          ? payload.message
          : undefined;
      const messageCorrelated =
        sessionError === null ? message === undefined : message === sessionError;
      return turnCorrelated && messageCorrelated;
    });
    if (mirroredRuntimeError) return null;
    return buildSessionPresentation(thread, event.payload.session, event.eventId);
  }
  return null;
}

/**
 * V2-native presentation. The routing identity lives on the app thread
 * (`thread.clientRouting`), and completion comes from a terminal provider turn. The
 * assistant message for that run supplies the spoken result; operator-facing
 * detail stays in T3.
 */
export function buildV2TurnPresentation(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly providerTurnId: string;
  readonly presentationId: string;
  readonly executionNodeId: EnvironmentId;
  readonly occurredAt: string;
}): CircePresentationEvent | null {
  const route = input.projection.thread.clientRouting;
  const originInteractionId = route?.originInteractionId;
  if (route === undefined || originInteractionId === undefined) return null;
  const turn = input.projection.providerTurns.find(
    (candidate) => candidate.id === input.providerTurnId,
  );
  if (turn === undefined) return null;
  if (turn.status === "interrupted" || turn.status === "cancelled") return null;
  const attempt = input.projection.attempts.find((candidate) => candidate.id === turn.runAttemptId);
  const runId = attempt?.runId ?? null;
  const message = input.projection.messages
    .filter(
      (candidate) =>
        candidate.role === "assistant" &&
        !candidate.streaming &&
        (runId === null || candidate.runId === runId),
    )
    .at(-1);
  const kind = turn.status === "completed" ? "completed" : "failed";
  const rawText = message?.text.trim() ?? "";
  const text =
    rawText.length > 0
      ? rawText.slice(0, 600)
      : kind === "completed"
        ? "The agent finished the task."
        : "The provider turn failed.";
  return {
    presentationId: input.presentationId,
    projectId: input.projection.thread.projectId,
    threadId: input.projection.thread.id,
    taskRef: {
      executionNodeId: input.executionNodeId,
      threadId: input.projection.thread.id,
    },
    origin: {
      originInteractionId,
      ...(route.originNodeId === undefined ? {} : { originNodeId: route.originNodeId }),
    },
    ...(route.requestId === undefined ? {} : { requestId: route.requestId }),
    kind,
    threadTitle: input.projection.thread.title,
    providerName: input.projection.thread.modelSelection.instanceId,
    text,
    createdAt: input.occurredAt,
  };
}

export function isPresentationForOrigin(
  event: CircePresentationEvent,
  originInteractionId: string,
  originNodeId?: string,
): boolean {
  return (
    event.origin.originInteractionId === originInteractionId &&
    (originNodeId === undefined || event.origin.originNodeId === originNodeId)
  );
}
