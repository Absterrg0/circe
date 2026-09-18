import type { CirceCommandNeedsInput } from "@circe/core/command";
import type { CirceCommandContext, CirceCommandTask } from "@circe/core/command";
import { acceptedBoundaries, composeDecision } from "@circe/core/decisionCompose";
import type { CirceDecisionOutcome, DecisionAnswers, DecisionRequest } from "@circe/core/decision";
import {
  buildDecisionRequest,
  segmentUtterance,
  type DecisionCatalog,
  type DecisionState,
} from "@circe/core/decisionRequest";
import { findCirceEffortDescriptor } from "@circe/core/modelChoice";
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

const LOCATION_PATTERN =
  /\b(?:in|at|for)\s+((?:the\s+)?[A-Z][\p{Letter}.'-]*(?:\s+[A-Z][\p{Letter}.'-]*){0,3})\b/gu;

/** Code-built place candidates for a lookup, capped and deduped. */
export function extractLocationCandidates(source: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(LOCATION_PATTERN.source, "gu");
  while ((match = pattern.exec(source)) !== null) {
    const value = match[1]?.trim();
    if (value === undefined || value.length === 0) continue;
    const key = fold(value);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(value);
    if (candidates.length >= 6) break;
  }
  return candidates;
}

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
