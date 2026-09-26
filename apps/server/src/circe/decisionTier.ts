import type { CirceCommandNeedsInput } from "@circe/core/command";
import type { CirceCommandContext, CirceCommandTask } from "@circe/core/command";
import {
  buildCirceOutcomeRequest,
  CIRCE_OUTCOME_CONVERSATION,
  CIRCE_OUTCOME_WORK,
  composeCirceOutcome,
  type CirceWorkResolution,
} from "@circe/core/controlClassify";
import type { CirceOutcome } from "@circe/core/controlOutcome";
import { acceptedBoundaries, composeDecision } from "@circe/core/decisionCompose";
import {
  choiceAnswer,
  type CirceDecisionOutcome,
  type DecisionAnswers,
  type DecisionRequest,
} from "@circe/core/decision";
import {
  buildDecisionRequest,
  segmentUtterance,
  type DecisionCatalog,
  type DecisionSegment,
  type DecisionState,
} from "@circe/core/decisionRequest";
import { findCirceEffortDescriptor } from "@circe/core/modelChoice";
import { extractLocationCandidates } from "@circe/core/place";
import { semanticBasename, projectSemanticNames } from "@circe/core/semantic";
import type { CirceSemanticProposal } from "@circe/core/semanticEvidence";
import { circeWebsiteUrl } from "@circe/core/website";
import type { CirceInterpretInput, OrchestrationThreadActivity } from "@circe/contracts";
import * as Effect from "effect/Effect";

import { getPendingCirceReplyState } from "@circe/core/confirmation";

/**
 * Host-side adapter for the decision tier. Builds the finite state and
 * catalogs with no internal IDs in option keys, runs one or two decision
 * requests, and composes the result. A decline returns to the caller so the
 * ordinary provider path can act as a safety net; a composed needs-input is a
 * deliberate Clarify and never falls through.
 */

export type DecisionTierResult =
  | { readonly status: "proposal"; readonly proposal: CirceSemanticProposal }
  | { readonly status: "needs-input"; readonly needsInput: CirceCommandNeedsInput }
  | { readonly status: "decline"; readonly reason: string };

const fold = (value: string): string => value.trim().toLowerCase();

const pendingRequestOf = (
  activities: ReadonlyArray<OrchestrationThreadActivity> | undefined,
): DecisionState["pendingRequest"] => {
  if (activities === undefined) return "none";
  const state = getPendingCirceReplyState(activities);
  if (state.status === "none") return "none";
  if (state.status === "ambiguous") return "ambiguous";
  return state.pending.kind === "approval" ? "approval" : "question";
};

const taskEntries = (input: CirceCommandContext): DecisionCatalog["tasks"] => {
  const seen = new Set<string>();
  const tasks: Array<DecisionCatalog["tasks"][number]> = [];
  const push = (task: CirceCommandTask): void => {
    const key = fold(task.title);
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    tasks.push({
      title: task.title,
      names: [task.title, task.objective].filter((name) => name.trim().length > 0),
      project: task.projectTitle,
      state: task.state,
      objective: task.objective,
    });
  };
  for (const task of [
    input.contextTask,
    input.focusedTask,
    input.referenceTask,
    ...(input.recentCommandTasks ?? []),
  ]) {
    if (task !== undefined) push(task);
  }
  for (const task of input.tasks) {
    const key = fold(task.title);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    tasks.push({
      title: task.title,
      names: [task.title, task.objective, ...(task.voiceAliases ?? [])].filter(
        (name) => name.trim().length > 0,
      ),
      state: task.state,
      objective: task.objective,
    });
  }
  return tasks;
};

const effortEntries = (input: CirceCommandContext): DecisionCatalog["efforts"] => {
  const seen = new Set<string>();
  const efforts: Array<{ id: string; label: string }> = [];
  for (const provider of input.providers) {
    for (const model of provider.models) {
      const descriptor = findCirceEffortDescriptor(model.capabilities?.optionDescriptors);
      if (descriptor === undefined) continue;
      for (const option of descriptor.options) {
        if (seen.has(option.id)) continue;
        seen.add(option.id);
        efforts.push({ id: option.id, label: option.label });
      }
    }
  }
  return efforts;
};

export function decisionCatalogFromContext(input: CirceCommandContext): DecisionCatalog {
  return {
    projects: input.projects.map((project) => ({
      title: project.title,
      names: [
        ...new Set(projectSemanticNames(project, input.aliases).filter((name) => name.length > 0)),
      ],
      qualifier: semanticBasename(project.workspaceRoot),
    })),
    tasks: taskEntries(input),
    providers: input.providers.map((provider) => ({
      names: [provider.displayName ?? provider.driver, provider.driver].filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      ),
      models: provider.models.map((model) => ({
        slug: model.slug,
        label: model.shortName ?? model.name,
      })),
    })),
    efforts: effortEntries(input),
  };
}

export function decisionStateFromContext(
  input: CirceCommandContext,
  source: string,
): DecisionState {
  const currentProject = input.projects.find((project) => project.id === input.currentProjectId);
  return {
    utterance: source,
    currentProjectKey: currentProject?.title ?? null,
    focusedTaskKey: input.focusedTask?.title ?? null,
    pendingRequest: pendingRequestOf(input.contextThread?.activities),
    continueContext: input.continueContext,
  };
}

export function decisionCatalogFromEvidence(input: CirceInterpretInput): DecisionCatalog {
  return {
    projects: input.projects.map((project) => ({
      title: project.title,
      names: [...new Set([project.title, ...project.names])].filter((name) => name.length > 0),
    })),
    tasks: input.tasks.map((task) => ({
      title: task.title,
      names: [task.title, ...(task.objective === undefined ? [] : [task.objective])].filter(
        (name) => name.length > 0,
      ),
      ...(task.project === undefined ? {} : { project: task.project }),
      ...(task.state === undefined ? {} : { state: task.state }),
      ...(task.objective === undefined ? {} : { objective: task.objective }),
    })),
    providers: input.providers.map((provider) => ({ names: [provider.name], models: [] })),
  };
}

export function decisionStateFromEvidence(input: CirceInterpretInput): DecisionState {
  return {
    utterance: input.utterance,
    currentProjectKey: input.currentProjectTitle ?? null,
    focusedTaskKey: input.focusedTask?.title ?? null,
    pendingRequest:
      input.pendingHint === "approval"
        ? "approval"
        : input.pendingHint === "question"
          ? "question"
          : input.pendingHint === "ambiguous"
            ? "ambiguous"
            : "none",
    continueContext: input.continueContext === true,
  };
}

export { extractLocationCandidates };

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s,;.!?]+/giu;

/** Code-built website candidates for the launcher, already allowlist-checked. */
export function extractWebsiteCandidates(source: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (value: string): void => {
    if (circeWebsiteUrl(value, source) === null) return;
    const key = fold(value);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(value);
  };
  let match: RegExpExecArray | null;
  const pattern = new RegExp(URL_PATTERN.source, "giu");
  while ((match = pattern.exec(source)) !== null) add(match[0]!);
  for (const alias of [
    "youtube",
    "you tube",
    "yt",
    "google",
    "github",
    "wikipedia",
    "reddit",
    "netflix",
    "spotify",
  ]) {
    if (new RegExp(`(?:^|[^a-z0-9.])${alias}(?![a-z0-9])`, "iu").test(source)) add(alias);
  }
  return candidates.slice(0, 8);
}

const resultFromComposition = (composed: ReturnType<typeof composeDecision>): DecisionTierResult =>
  composed.status === "proposal"
    ? { status: "proposal", proposal: composed.proposal }
    : {
        status: "needs-input",
        needsInput: {
          status: "needs-input",
          reason: composed.reason,
          prompt: composed.prompt,
          choices: composed.choices,
        },
      };

/**
 * One or two decision requests per turn. The second request is built only
 * after accepted boundaries exist, because per-segment questions cannot be
 * written before the segments do. A segment decline declines the whole turn so
 * nothing half-runs.
 */
export const runCirceDecisionTier = (input: {
  readonly source: string;
  readonly state: DecisionState;
  readonly catalog: DecisionCatalog;
  readonly decide: (request: DecisionRequest) => Effect.Effect<CirceDecisionOutcome>;
}): Effect.Effect<DecisionTierResult> =>
  Effect.gen(function* () {
    const locationCandidates = extractLocationCandidates(input.source);
    const websiteCandidates = extractWebsiteCandidates(input.source);
    const first = buildDecisionRequest({
      state: input.state,
      catalog: input.catalog,
      ...(locationCandidates.length === 0 ? {} : { locationCandidates }),
      ...(websiteCandidates.length === 0 ? {} : { websiteCandidates }),
    });
    const firstOutcome = yield* input.decide(first.request);
    if (firstOutcome.status === "decline") {
      return { status: "decline", reason: firstOutcome.reason };
    }
    // Record the exact model an alias resolved to, per turn, because aliases move.
    yield* Effect.logDebug("Circe decision resolved", { model: firstOutcome.model });
    const accepted = acceptedBoundaries(first.boundaries, firstOutcome.answers);
    const segments = segmentUtterance(input.source, accepted);
    if (segments.length >= 2) {
      const answersList: Array<DecisionAnswers> = [];
      for (const [index, segment] of segments.entries()) {
        const segmentRequest = buildDecisionRequest({
          state: { ...input.state, utterance: segment.text },
          catalog: input.catalog,
        });
        const segmentOutcome = yield* input.decide(segmentRequest.request);
        if (segmentOutcome.status === "decline") {
          return { status: "decline", reason: segmentOutcome.reason };
        }
        const prefix = `seg${index}_`;
        answersList.push(
          Object.fromEntries(
            Object.entries(segmentOutcome.answers).map(([id, answer]) => [
              `${prefix}${id}`,
              answer,
            ]),
          ),
        );
      }
      return resultFromComposition(
        composeDecision({
          source: input.source,
          table: first.table,
          answers: firstOutcome.answers,
          boundaries: first.boundaries,
          segments,
          segmentAnswers: answersList,
          state: input.state,
        }),
      );
    }
    return resultFromComposition(
      composeDecision({
        source: input.source,
        table: first.table,
        answers: firstOutcome.answers,
        boundaries: first.boundaries,
        state: input.state,
      }),
    );
  });

export type CirceOutcomeTierResult =
  | { readonly status: "outcome"; readonly outcome: CirceOutcome }
  | { readonly status: "decline"; readonly reason: string };

/**
 * The single live classifier. One TypeSafe request asks which outcome the turn
 * resolves to; composition consults only the questions that outcome owns, so a
 * weather ask never drags project, task, or compound questions into the answer.
 * Work keeps the Director's authority through the supplied resolver; a
 * conversation has no decision answer (the provider net speaks it), so the tier
 * declines and the caller falls back instead of inventing one.
 */
export const runCirceOutcomeTier = (input: {
  readonly source: string;
  readonly state: DecisionState;
  readonly catalog: DecisionCatalog;
  readonly nodeTools: ReadonlyArray<string>;
  readonly clientTools: ReadonlyArray<string>;
  readonly appCandidates?: ReadonlyArray<string>;
  readonly mediaCandidates?: ReadonlyArray<string>;
  readonly locationCandidates?: ReadonlyArray<string>;
  readonly websiteCandidates?: ReadonlyArray<string>;
  readonly decide: (request: DecisionRequest) => Effect.Effect<CirceDecisionOutcome>;
  readonly work: (proposal: CirceSemanticProposal) => CirceWorkResolution;
}): Effect.Effect<CirceOutcomeTierResult> =>
  Effect.gen(function* () {
    const locationCandidates = input.locationCandidates ?? extractLocationCandidates(input.source);
    const websiteCandidates = input.websiteCandidates ?? extractWebsiteCandidates(input.source);
    const built = buildCirceOutcomeRequest({
      state: input.state,
      catalog: input.catalog,
      nodeTools: input.nodeTools,
      clientTools: input.clientTools,
      locationCandidates,
      websiteCandidates,
      ...(input.appCandidates === undefined ? {} : { appCandidates: input.appCandidates }),
      ...(input.mediaCandidates === undefined ? {} : { mediaCandidates: input.mediaCandidates }),
    });
    const first = yield* input.decide(built.request);
    if (first.status === "decline") {
      return { status: "decline", reason: first.reason } satisfies CirceOutcomeTierResult;
    }
    yield* Effect.logDebug("Circe outcome resolved", { model: first.model });
    const outcomeChoice = choiceAnswer(first.answers, "outcome");
    if (outcomeChoice === undefined) {
      return {
        status: "decline",
        reason: "decision-invalid-response",
      } satisfies CirceOutcomeTierResult;
    }
    if (outcomeChoice.choice === CIRCE_OUTCOME_CONVERSATION) {
      // A conversation has no decision answer. The node answers through the
      // provider: a scoped project gets a durable provider thread (whose real
      // answer arrives on the thread), and only a project-free question needs
      // the provider to speak inline. Returning the outcome lets the caller
      // pick; the tier never invents prose.
      return {
        status: "outcome",
        outcome: { kind: "conversation", answer: "" },
      } satisfies CirceOutcomeTierResult;
    }
    // Only a work outcome can be a compound; tool and conversation turns never
    // split, so their questions are not asked and their turns never segment.
    let segments: ReadonlyArray<DecisionSegment> | undefined;
    let segmentAnswers: ReadonlyArray<DecisionAnswers> | undefined;
    if (outcomeChoice.choice === CIRCE_OUTCOME_WORK) {
      const accepted = acceptedBoundaries(built.boundaries, first.answers);
      const spokenSegments = segmentUtterance(input.source, accepted);
      if (spokenSegments.length >= 2) {
        const answersList: Array<DecisionAnswers> = [];
        for (const [index, segment] of spokenSegments.entries()) {
          const segmentRequest = buildDecisionRequest({
            state: { ...input.state, utterance: segment.text },
            catalog: input.catalog,
          });
          const segmentOutcome = yield* input.decide(segmentRequest.request);
          if (segmentOutcome.status === "decline") {
            return {
              status: "decline",
              reason: segmentOutcome.reason,
            } satisfies CirceOutcomeTierResult;
          }
          const prefix = `seg${index}_`;
          answersList.push(
            Object.fromEntries(
              Object.entries(segmentOutcome.answers).map(([id, answer]) => [
                `${prefix}${id}`,
                answer,
              ]),
            ),
          );
        }
        segments = spokenSegments;
        segmentAnswers = answersList;
      }
    }
    const outcome = composeCirceOutcome({
      source: input.source,
      state: input.state,
      table: built.table,
      boundaries: built.boundaries,
      answers: first.answers,
      tools: built.tools,
      locationCandidates,
      websiteCandidates,
      ...(segments === undefined ? {} : { segments }),
      ...(segmentAnswers === undefined ? {} : { segmentAnswers }),
      work: input.work,
    });
    return { status: "outcome", outcome } satisfies CirceOutcomeTierResult;
  });
