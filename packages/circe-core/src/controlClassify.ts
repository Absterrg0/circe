import type { CirceCommand, CirceCommandInterpretation } from "./command.ts";
import type { CirceClarification, CirceOutcome, CirceRefusalReason } from "./controlOutcome.ts";
import {
  availableCirceTools,
  type CirceTool,
  type CirceToolArguments,
  type CirceToolParameter,
} from "./controlTools.ts";
import { choiceAnswer, noulHolds, type DecisionAnswers, type DecisionRequest } from "./decision.ts";
import {
  buildDecisionRequest,
  locateNameSpan,
  type BoundaryCandidate,
  type DecisionBuildInput,
  type DecisionOptionTable,
  type DecisionState,
} from "./decisionRequest.ts";
import { composeDecision } from "./decisionCompose.ts";
import type { CirceSemanticProposal } from "./semanticEvidence.ts";
import { NONE_OPTION } from "./toolRegistry.ts";

/**
 * The single classifier request and its deterministic composition.
 *
 * One System One request selects among work, conversation, refusal,
 * clarification, and the offered bounded tools. The question is finite and
 * closed: an offered tool is present only when this host can actually run it,
 * and every text parameter is a Choice over code-built candidates. The model
 * never spells an ID, a span, or a target; all of those are derived here from
 * the selection plus the original utterance.
 */

export const CIRCE_OUTCOME_WORK = "work";
export const CIRCE_OUTCOME_CONVERSATION = "conversation";
export const CIRCE_OUTCOME_REFUSAL = "refusal";
export const CIRCE_OUTCOME_CLARIFY = "clarification";

const OUTCOME_CRITERIA: Readonly<Record<string, string>> = {
  [CIRCE_OUTCOME_WORK]:
    "Create, continue, steer, queue, stop, focus, review, reroute, report, or list project work.",
  [CIRCE_OUTCOME_CONVERSATION]: "Answer a general question unrelated to any task or project.",
  [CIRCE_OUTCOME_REFUSAL]: "The request cannot be done as one action.",
  [CIRCE_OUTCOME_CLARIFY]: "The request is ambiguous and needs one typed clarifying question.",
};

const OUTCOME_FLOOR = 0.6;

export interface CirceOfferInput {
  readonly nodeTools: ReadonlyArray<string>;
  readonly clientTools: ReadonlyArray<string>;
  readonly locationCandidates?: ReadonlyArray<string>;
  readonly websiteCandidates?: ReadonlyArray<string>;
}

/**
 * Tools the classifier may be offered. A tool whose required text parameter has
 * no code-built candidate set is not offered, because a closed Choice cannot be
 * written for it and free-text tool arguments are forbidden.
 */
export function offeredCirceTools(input: CirceOfferInput): ReadonlyArray<CirceTool> {
  const locationCandidates = input.locationCandidates ?? [];
  const websiteCandidates = input.websiteCandidates ?? [];
  return availableCirceTools({
    nodeTools: input.nodeTools,
    clientTools: input.clientTools,
  }).filter((tool) =>
    tool.parameters.every((parameter) =>
      parameterIsOfferable(parameter, {
        locationCandidates,
        websiteCandidates,
      }),
    ),
  );
}

function parameterIsOfferable(
  parameter: CirceToolParameter,
  candidates: {
    readonly locationCandidates: ReadonlyArray<string>;
    readonly websiteCandidates: ReadonlyArray<string>;
  },
): boolean {
  if (parameter.kind !== "text" || !parameter.required) return true;
  switch (parameter.candidates.kind) {
    case "location":
      return candidates.locationCandidates.length > 0;
    case "website":
      return candidates.websiteCandidates.length > 0;
    case "app":
    case "media-target":
    case "residual":
      return false;
  }
}

function candidatesFor(
  parameter: CirceToolParameter,
  input: CirceOfferInput,
): ReadonlyArray<string> {
  if (parameter.kind !== "text") return [];
  switch (parameter.candidates.kind) {
    case "location":
      return input.locationCandidates ?? [];
    case "website":
      return input.websiteCandidates ?? [];
    case "app":
    case "media-target":
    case "residual":
      return [];
  }
}

function toolParameterQuestions(
  tool: CirceTool,
  offer: CirceOfferInput,
): Record<string, DecisionRequest["questions"][string]> {
  const questions: Record<string, DecisionRequest["questions"][string]> = {};
  for (const parameter of tool.parameters) {
    const id = `tool_${tool.name}_${parameter.name}`;
    if (parameter.kind === "enum") {
      const criteria: Record<string, string | null> = {};
      for (const value of parameter.values) criteria[value] = null;
      criteria[NONE_OPTION] = "Not specified.";
      questions[id] = {
        type: "choice",
        instructions: `Which ${parameter.name} did the user ask for?`,
        criteria,
      };
      continue;
    }
    if (parameter.kind === "boolean") {
      questions[id] = {
        type: "noul",
        instructions: `Is the ${parameter.name} parameter present in the request?`,
        criteria: { true: `${parameter.name} is given.`, false: `${parameter.name} is omitted.` },
      };
      continue;
    }
    const values = candidatesFor(parameter, offer);
    if (values.length === 0) continue;
    const criteria: Record<string, string | null> = {};
    for (const value of values) criteria[value] = null;
    criteria[NONE_OPTION] = "Not specified.";
    questions[id] = {
      type: "choice",
      instructions: `Which ${parameter.name} did the user name?`,
      criteria,
    };
  }
  return questions;
}

export interface BuildCirceOutcomeRequestInput extends DecisionBuildInput, CirceOfferInput {}

export interface CirceOutcomeRequest {
  readonly request: DecisionRequest;
  readonly table: DecisionOptionTable;
  readonly boundaries: ReadonlyArray<BoundaryCandidate>;
  readonly tools: ReadonlyArray<CirceTool>;
}

/**
 * One finite request over every outcome this host can produce. Work questions
 * are reused unchanged so the deterministic composer keeps sole authority over
 * spans, destinations, tasks, providers, models, and effort.
 */
export function buildCirceOutcomeRequest(
  input: BuildCirceOutcomeRequestInput,
): CirceOutcomeRequest {
  const base = buildDecisionRequest({
    state: input.state,
    catalog: input.catalog,
    ...(input.locationCandidates === undefined
      ? {}
      : { locationCandidates: input.locationCandidates }),
    ...(input.websiteCandidates === undefined
      ? {}
      : { websiteCandidates: input.websiteCandidates }),
  });
  const tools = offeredCirceTools(input);
  const outcomeCriteria: Record<string, string | null> = { ...OUTCOME_CRITERIA };
  for (const tool of tools) outcomeCriteria[tool.name] = tool.description;
  const toolQuestions: Record<string, DecisionRequest["questions"][string]> = {};
  for (const tool of tools) Object.assign(toolQuestions, toolParameterQuestions(tool, input));
  return {
    request: {
      ...base.request,
      questions: {
        ...base.request.questions,
        outcome: {
          type: "choice",
          instructions:
            "Which single outcome does this request resolve to: work, a bounded tool, conversation, a refusal, or a clarification?",
          criteria: outcomeCriteria,
        },
        ...toolQuestions,
      },
    },
    table: base.table,
    boundaries: base.boundaries,
    tools,
  };
}

export type CirceWorkResolution =
  | { readonly status: "commands"; readonly commands: ReadonlyArray<CirceCommand> }
  | { readonly status: "clarification"; readonly clarification: CirceClarification }
  | { readonly status: "refused"; readonly reason: CirceRefusalReason };

export interface ComposeCirceOutcomeInput {
  readonly source: string;
  readonly state: DecisionState;
  readonly table: DecisionOptionTable;
  readonly boundaries: ReadonlyArray<BoundaryCandidate>;
  readonly answers: DecisionAnswers;
  readonly tools: ReadonlyArray<CirceTool>;
  readonly locationCandidates?: ReadonlyArray<string>;
  readonly websiteCandidates?: ReadonlyArray<string>;
  /** Bounded inline answer for a conversation; supplied by the provider path. */
  readonly conversationAnswer?: string;
  /** Host authority for work: validate the proposal and return typed commands. */
  readonly work: (proposal: CirceSemanticProposal) => CirceWorkResolution;
}

const asArguments = (
  entries: ReadonlyArray<readonly [string, string | boolean]>,
): CirceToolArguments => Object.fromEntries(entries);

function readEnumArgument(answers: DecisionAnswers, id: string): string | undefined {
  const answer = choiceAnswer(answers, id);
  return answer === undefined || answer.choice === NONE_OPTION ? undefined : answer.choice;
}

function readTextArgument(
  answers: DecisionAnswers,
  id: string,
  source: string,
): { readonly value: string } | { readonly missing: true } {
  const answer = choiceAnswer(answers, id);
  if (answer === undefined || answer.choice === NONE_OPTION) return { missing: true };
  if (locateNameSpan(source, answer.choice) === undefined) return { missing: true };
  return { value: answer.choice };
}

function toolArgumentClarification(
  tool: CirceTool,
  input: ComposeCirceOutcomeInput,
): CirceClarification {
  const locationCandidates = input.locationCandidates ?? [];
  const websiteCandidates = input.websiteCandidates ?? [];
  if (tool.name === "weather" || tool.name === "time") {
    return {
      kind: "lookup",
      prompt: `Which place should I check for ${tool.name}?`,
      tool: tool.name,
      candidates: locationCandidates,
    };
  }
  if (tool.name === "open-website") {
    return {
      kind: "website",
      prompt: "Which site should I open?",
      candidates: websiteCandidates,
    };
  }
  return {
    kind: "model",
    prompt: `I need one more detail before I can run ${tool.name}.`,
    choices: [],
  };
}

function composeToolOutcome(input: ComposeCirceOutcomeInput, tool: CirceTool): CirceOutcome {
  const entries: Array<readonly [string, string | boolean]> = [];
  for (const parameter of tool.parameters) {
    const id = `tool_${tool.name}_${parameter.name}`;
    if (parameter.kind === "enum") {
      const value = readEnumArgument(input.answers, id);
      if (value === undefined) {
        if (!parameter.required) continue;
        return {
          kind: "clarification",
          clarification: toolArgumentClarification(tool, input),
        };
      }
      entries.push([parameter.name, value]);
      continue;
    }
    if (parameter.kind === "boolean") {
      if (noulHolds(input.answers, id, OUTCOME_FLOOR) === true)
        entries.push([parameter.name, true]);
      continue;
    }
    const text = readTextArgument(input.answers, id, input.source);
    if ("missing" in text) {
      if (!parameter.required) continue;
      return { kind: "clarification", clarification: toolArgumentClarification(tool, input) };
    }
    entries.push([parameter.name, text.value]);
  }
  const args = asArguments(entries);
  if (tool.host === "node") {
    return { kind: "tool-answer", host: "node", tool: tool.name, risk: tool.risk, args };
  }
  return {
    kind: "client-action",
    host: "client",
    tool: tool.name,
    risk: tool.risk,
    args,
    speech: tool.renderAccepted(args),
  };
}

/** The deterministic outcome of one classified turn. */
export function composeCirceOutcome(input: ComposeCirceOutcomeInput): CirceOutcome {
  const outcome = choiceAnswer(input.answers, "outcome");
  if (outcome === undefined || outcome.confidence < OUTCOME_FLOOR) {
    return { kind: "refused", reason: "confidence-too-low" };
  }
  const selection = outcome.choice;
  if (selection === CIRCE_OUTCOME_REFUSAL) {
    return { kind: "refused", reason: "classifier-declined" };
  }
  if (selection === CIRCE_OUTCOME_CLARIFY) {
    return { kind: "clarification", clarification: composeClarification(input) };
  }
  if (selection === CIRCE_OUTCOME_CONVERSATION) {
    const answer = input.conversationAnswer?.trim() ?? "";
    return answer.length === 0
      ? { kind: "refused", reason: "classifier-declined" }
      : { kind: "conversation", answer };
  }
  const tool = input.tools.find((candidate) => candidate.name === selection);
  if (tool !== undefined) return composeToolOutcome(input, tool);
  return composeWorkOutcome(input);
}

function composeWorkOutcome(input: ComposeCirceOutcomeInput): CirceOutcome {
  const composed = composeDecision({
    source: input.source,
    table: input.table,
    answers: input.answers,
    boundaries: input.boundaries,
    state: input.state,
  });
  if (composed.status === "needs-input") {
    return {
      kind: "clarification",
      clarification: clarificationFromNeedsInput(
        composed.prompt,
        composed.projectClarification,
        composed.taskClarification,
      ),
    };
  }
  const resolution = input.work(composed.proposal);
  if (resolution.status === "commands") {
    return { kind: "work", commands: resolution.commands };
  }
  if (resolution.status === "clarification") {
    return { kind: "clarification", clarification: resolution.clarification };
  }
  return { kind: "refused", reason: resolution.reason };
}

function clarificationFromNeedsInput(
  prompt: string,
  projectClarification:
    | { readonly candidates: ReadonlyArray<{ readonly projectId: string; readonly label: string }> }
    | undefined,
  taskClarification:
    | { readonly candidates: ReadonlyArray<{ readonly threadId: string; readonly label: string }> }
    | undefined,
): CirceClarification {
  if (projectClarification !== undefined) {
    return { kind: "project", prompt, candidates: projectClarification.candidates };
  }
  if (taskClarification !== undefined) {
    return { kind: "task", prompt, candidates: taskClarification.candidates };
  }
  return { kind: "model", prompt, choices: [] };
}

function composeClarification(input: ComposeCirceOutcomeInput): CirceClarification {
  const composed = composeDecision({
    source: input.source,
    table: input.table,
    answers: input.answers,
    boundaries: input.boundaries,
    state: input.state,
  });
  if (composed.status === "needs-input") {
    return clarificationFromNeedsInput(
      composed.prompt,
      composed.projectClarification,
      composed.taskClarification,
    );
  }
  if (input.table.projects.length > 1) {
    return {
      kind: "project",
      prompt: "Which project did you mean?",
      candidates: input.table.projects.map((project) => ({
        projectId: project.key,
        label: project.title,
      })),
    };
  }
  return { kind: "model", prompt: "Tell me a little more so I can act.", choices: [] };
}

export interface CirceProposalOutcomeInput {
  readonly proposal: CirceSemanticProposal;
  readonly tools: ReadonlyArray<CirceTool>;
  /** Work resolution; absent means the proposal is refused. */
  readonly work?: (proposal: CirceSemanticProposal) => CirceWorkResolution;
  readonly conversationAnswer?: string;
}

/**
 * Map one accepted semantic proposal into an outcome. This is the live seam:
 * the decision tier already produced a proposal, so the outcome is derived from
 * that proposal rather than re-running composition. A proposal whose action is
 * a bounded tool resolves to the tool outcome, and everything else is handed to
 * the host work resolver.
 */
export function circeOutcomeFromProposal(input: CirceProposalOutcomeInput): CirceOutcome {
  const { proposal } = input;
  const lookup = proposal.lookup ?? undefined;
  if (proposal.action === "lookup" && lookup !== undefined) {
    const tool = input.tools.find(
      (candidate) => candidate.name === (lookup.kind === "time" ? "time" : "weather"),
    );
    if (tool === undefined) return { kind: "refused", reason: "unsupported-command" };
    return {
      kind: "tool-answer",
      host: "node",
      tool: tool.name,
      risk: tool.risk,
      args: { location: lookup.location, day: lookup.day },
    };
  }
  const website = proposal.website ?? undefined;
  if (proposal.action === "open-website" && website !== undefined) {
    const tool = input.tools.find((candidate) => candidate.name === "open-website");
    if (tool === undefined) return { kind: "refused", reason: "unsupported-command" };
    const args: CirceToolArguments = { website };
    return {
      kind: "client-action",
      host: "client",
      tool: tool.name,
      risk: tool.risk,
      args,
      speech: tool.renderAccepted(args),
    };
  }
  if (proposal.action === "converse") {
    const answer = (proposal.answer ?? input.conversationAnswer ?? "").trim();
    return answer.length === 0
      ? { kind: "refused", reason: "classifier-declined" }
      : { kind: "conversation", answer };
  }
  if (proposal.action === "unsupported") {
    return { kind: "refused", reason: "unsupported-command" };
  }
  if (input.work === undefined) {
    return { kind: "refused", reason: "unsupported-command" };
  }
  const resolution = input.work(proposal);
  if (resolution.status === "commands") return { kind: "work", commands: resolution.commands };
  if (resolution.status === "clarification") {
    return { kind: "clarification", clarification: resolution.clarification };
  }
  return { kind: "refused", reason: resolution.reason };
}

/**
 * Map a Director interpretation into an outcome for the paths that never saw a
 * proposal (a deterministic approval verdict, or a mesh proposal that failed
 * schema decoding). A command is work; a converse command is conversation; a
 * needs-input without a project or task is a clarification carrying its prompt.
 */
export function circeOutcomeFromInterpretation(
  interpretation: CirceCommandInterpretation,
): CirceOutcome {
  if (interpretation.status === "command") {
    if (interpretation.command.type === "converse") {
      return { kind: "conversation", answer: interpretation.command.answer };
    }
    return { kind: "work", commands: [interpretation.command] };
  }
  if (interpretation.projectClarification !== undefined) {
    return {
      kind: "clarification",
      clarification: {
        kind: "project",
        prompt: interpretation.prompt,
        candidates: interpretation.projectClarification.candidates.map((candidate) => ({
          projectId: candidate.projectId,
          label: candidate.label,
        })),
      },
    };
  }
  if (interpretation.taskClarification !== undefined) {
    return {
      kind: "clarification",
      clarification: {
        kind: "task",
        prompt: interpretation.prompt,
        candidates: interpretation.taskClarification.candidates.map((candidate) => ({
          threadId: candidate.threadId,
          label: candidate.label,
        })),
      },
    };
  }
  return { kind: "refused", reason: "unsupported-command" };
}

export type CirceOutcomeKind = CirceOutcome["kind"];

/** The offered tool names, for tests and host capability reporting. */
export const offeredToolNames = (tools: ReadonlyArray<CirceTool>): ReadonlyArray<string> =>
  tools.map((tool) => tool.name);
