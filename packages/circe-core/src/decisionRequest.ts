import type { CirceSemanticProposalAction } from "./semanticEvidence.ts";
import { normalizeDestinationPhrase, stripDestinationQuotes } from "./destinationSpan.ts";
import type { DecisionQuestion, DecisionRequest } from "./decision.ts";
import {
  CIRCE_TOOLS,
  NONE_OPTION,
  buildToolArgumentQuestions,
  buildToolChoiceQuestion,
} from "./toolRegistry.ts";

/**
 * Deterministic construction of the finite decision request.
 *
 * The model only ever selects an element of a supplied set or evaluates a
 * boolean predicate. Every option set here is non-empty and closed, choice
 * keys are human-readable names with no internal IDs, and all spans, IDs,
 * sequences, and numbers are derived in code afterwards. This module is pure:
 * same state and catalog produce byte-identical requests.
 */

export interface DecisionProjectInput {
  readonly title: string;
  readonly names: ReadonlyArray<string>;
  /** Optional node qualifier used only to disambiguate a duplicate key. */
  readonly qualifier?: string;
}

export interface DecisionTaskInput {
  readonly title: string;
  readonly names: ReadonlyArray<string>;
  readonly project?: string;
  readonly state?: string;
  readonly objective?: string;
  readonly qualifier?: string;
}

export interface DecisionProviderModelInput {
  readonly slug: string;
  readonly label: string;
}

export interface DecisionProviderInput {
  readonly names: ReadonlyArray<string>;
  readonly models: ReadonlyArray<DecisionProviderModelInput>;
}

export interface DecisionEffortInput {
  readonly id: string;
  readonly label: string;
}

export interface DecisionCatalog {
  readonly projects: ReadonlyArray<DecisionProjectInput>;
  readonly tasks: ReadonlyArray<DecisionTaskInput>;
  readonly providers: ReadonlyArray<DecisionProviderInput>;
  readonly efforts?: ReadonlyArray<DecisionEffortInput> | undefined;
}

export interface DecisionOptionEntry {
  readonly key: string;
  readonly names: ReadonlyArray<string>;
  readonly title: string;
}

export interface DecisionProviderOption extends DecisionOptionEntry {
  readonly models: ReadonlyArray<{ readonly key: string; readonly slug: string }>;
}

export interface DecisionEffortOption {
  readonly key: string;
  readonly id: string;
}

export interface DecisionOptionTable {
  readonly projects: ReadonlyArray<DecisionOptionEntry>;
  readonly tasks: ReadonlyArray<DecisionOptionEntry>;
  readonly providers: ReadonlyArray<DecisionProviderOption>;
  readonly efforts: ReadonlyArray<DecisionEffortOption>;
}

export interface DecisionState {
  readonly utterance: string;
  readonly currentProjectKey: string | null;
  readonly focusedTaskKey: string | null;
  readonly pendingRequest: "none" | "approval" | "question" | "ambiguous";
  readonly continueContext: boolean;
  readonly heardMention?: string;
}

export interface DecisionBuildInput {
  readonly state: DecisionState;
  readonly catalog: DecisionCatalog;
  readonly locationCandidates?: ReadonlyArray<string>;
  readonly websiteCandidates?: ReadonlyArray<string>;
}

export interface BoundaryCandidate {
  readonly id: string;
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly left: string;
  readonly right: string;
}

/**
 * Confidence floors by risk. Destructive controls (stop, reroute) require the
 * highest confidence and always add host confirmation; read-only selections
 * may act at the lowest. Non-decreasing in risk, checked by test.
 */
export const CIRCE_DECISION_THRESHOLDS = {
  predicate: 0.5,
  boundary: 0.6,
  clarification: 0.5,
  readOnly: 0.6,
  mutating: 0.7,
  destructive: 0.8,
} as const;

export type CirceDecisionRisk = "read-only" | "mutating" | "destructive";

const DESTRUCTIVE_ACTIONS: ReadonlySet<CirceSemanticProposalAction> = new Set(["stop", "reroute"]);
const MUTATING_ACTIONS: ReadonlySet<CirceSemanticProposalAction> = new Set([
  "start",
  "continue",
  "steer",
  "queue",
  "review",
  "focus-project",
  "focus-task",
]);

export function riskForAction(action: CirceSemanticProposalAction): CirceDecisionRisk {
  if (DESTRUCTIVE_ACTIONS.has(action)) return "destructive";
  if (MUTATING_ACTIONS.has(action)) return "mutating";
  return "read-only";
}

export function thresholdForRisk(risk: CirceDecisionRisk): number {
  switch (risk) {
    case "read-only":
      return CIRCE_DECISION_THRESHOLDS.readOnly;
    case "mutating":
      return CIRCE_DECISION_THRESHOLDS.mutating;
    case "destructive":
      return CIRCE_DECISION_THRESHOLDS.destructive;
  }
}

const ACTION_CRITERIA: Readonly<Record<CirceSemanticProposalAction, string>> = {
  start: "Create new work. It is not a control of existing work.",
  continue: "Add a turn to an existing ready task. It is not new work.",
  steer: "Add direction to work that is already running. It is not a new task.",
  queue: "Schedule a follow-up for later. It is not immediate work.",
  stop: "Interrupt running work. Destructive; only a clear interrupt.",
  status: "Report the live state of one task.",
  review: "Create a review of existing work.",
  reroute: "Recreate a task in another project. Destructive.",
  "focus-project": "Change which project new work targets; project name given bare.",
  "focus-task": "Change the selected task; no new work is created.",
  "list-projects": "List the projects this node owns.",
  converse: "Answer a general question unrelated to any task or project.",
  lookup: "Answer weather or local time in a named place. No project or task.",
  "open-website": "Open a named site or web address on the user's device.",
  browse:
    "Operate a website toward a goal over several grounded steps; the origin client confirms first.",
  unsupported: "A request Circe cannot do as one action.",
  sequence: "Two or more genuinely independent commands in one turn.",
};

export const CIRCE_DECISION_ACTIONS: ReadonlyArray<CirceSemanticProposalAction> = [
  "start",
  "continue",
  "steer",
  "queue",
  "stop",
  "status",
  "review",
  "reroute",
  "focus-project",
  "focus-task",
  "list-projects",
  "converse",
  "lookup",
  "open-website",
  "browse",
  "unsupported",
  "sequence",
];

export type CirceResponseStrategy =
  | "act"
  | "tool"
  | "status_report"
  | "list_report"
  | "conversation_thread"
  | "refuse";

export const CIRCE_RESPONSE_STRATEGIES: ReadonlyArray<CirceResponseStrategy> = [
  "act",
  "tool",
  "status_report",
  "list_report",
  "conversation_thread",
  "refuse",
];

const RESPONSE_STRATEGY_CRITERIA: Readonly<Record<CirceResponseStrategy, string>> = {
  act: "Create, continue, steer, queue, stop, focus, review, or reroute project work.",
  tool: "Answer with one bounded host or client tool (weather, time, website).",
  status_report: "Report the live state of an existing task.",
  list_report: "List the projects this node owns.",
  conversation_thread:
    "Open-domain conversation with no task work; the provider answers in a durable thread.",
  refuse: "The request cannot be done as one action.",
};

export const CIRCE_MAX_SEGMENTS = 4;
const MAX_PROJECTS = 32;
const MAX_TASKS = 16;
const MAX_PROVIDERS = 16;
const MAX_MODEL_OPTIONS = 64;
const MAX_BOUNDARIES = 8;
const PREVIEW_CHARS = 48;

const fold = (value: string): string => normalizeDestinationPhrase(stripDestinationQuotes(value));

/**
 * Unique, human-readable option keys. A duplicate key gets its optional node
 * qualifier, then a numeric suffix, so two same-named projects stay distinct
 * without ever exposing an internal ID to the model.
 */
function assignKeys<T>(
  inputs: ReadonlyArray<T>,
  keyOf: (input: T) => string,
  qualifierOf: (input: T) => string | undefined,
): ReadonlyArray<{ readonly input: T; readonly key: string }> {
  const used = new Set<string>();
  const out: Array<{ input: T; key: string }> = [];
  for (const input of inputs) {
    const base = keyOf(input).trim() || "unnamed";
    let key = base;
    if (used.has(key)) {
      const qualifier = qualifierOf(input)?.trim();
      if (qualifier !== undefined && qualifier.length > 0) key = `${base} (${qualifier})`;
    }
    let suffix = 2;
    const stem = key;
    while (used.has(key)) {
      key = `${stem} (${suffix})`;
      suffix += 1;
    }
    used.add(key);
    out.push({ input, key });
  }
  return out;
}

export function buildOptionTable(catalog: DecisionCatalog): DecisionOptionTable {
  const projectEntries = assignKeys(
    catalog.projects.slice(0, MAX_PROJECTS),
    (project) => project.title,
    (project) => project.qualifier,
  ).map(({ input, key }) => ({ key, title: input.title, names: input.names }));
  const taskEntries = assignKeys(
    catalog.tasks.slice(0, MAX_TASKS),
    (task) => task.title,
    (task) => task.qualifier,
  ).map(({ input, key }) => ({ key, title: input.title, names: input.names }));
  const usedModelKeys = new Set<string>();
  const providerEntries = assignKeys(
    catalog.providers.slice(0, MAX_PROVIDERS),
    (provider) => provider.names[0] ?? "provider",
    () => undefined,
  ).map(({ input, key }) => {
    const models = input.models
      .map((model) => ({ key: `${key}/${model.slug}`, slug: model.slug }))
      .slice(0, MAX_MODEL_OPTIONS)
      .filter((model) => {
        if (usedModelKeys.has(model.key)) return false;
        usedModelKeys.add(model.key);
        return true;
      });
    return { key, title: key, names: input.names, models };
  });
  const efforts = assignKeys(
    (catalog.efforts ?? []).slice(0, 16),
    (effort) => effort.id,
    () => undefined,
  ).map(({ input, key }) => ({ key, id: input.id }));
  return { projects: projectEntries, tasks: taskEntries, providers: providerEntries, efforts };
}

const choiceQuestion = (
  instructions: string,
  criteria: Record<string, string | null>,
): DecisionQuestion => ({ type: "choice", instructions, criteria });

const noulQuestion = (instructions: string, yes: string, no: string): DecisionQuestion => ({
  type: "noul",
  instructions,
  criteria: { true: yes, false: no },
});

const withNone = (criteria: Record<string, string | null>): Record<string, string | null> => ({
  ...criteria,
  [NONE_OPTION]: "None of these; nothing was named.",
});

const BOUNDARY_PATTERN = /\b(?:and\s+then|after\s+that|afterwards|then|also|next|and)\b|[,;.]/giu;

/**
 * Candidate boundaries where a new, independent command might begin. Detection
 * and location are separate: this only enumerates positions; a boundary Noul
 * decides each one, and code enforces the partition law on the survivors.
 */
export function candidateBoundaries(source: string): ReadonlyArray<BoundaryCandidate> {
  const candidates: BoundaryCandidate[] = [];
  const pattern = new RegExp(BOUNDARY_PATTERN.source, "giu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (candidates.length >= MAX_BOUNDARIES) break;
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;
    const left = source.slice(Math.max(0, matchStart - PREVIEW_CHARS), matchStart).trim();
    const right = source.slice(matchEnd, matchEnd + PREVIEW_CHARS).trim();
    if (left.length === 0 || right.length === 0) continue;
    candidates.push({
      id: `boundary_${candidates.length}`,
      matchStart,
      matchEnd,
      left,
      right,
    });
  }
  return candidates;
}

export interface DecisionSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The partition law. Accepted boundaries define segments that are contiguous,
 * non-overlapping, and cover the command text; empty segments are dropped and
 * the count is bounded. Returns a single whole segment when fewer than two
 * survive, so callers never invent a split.
 */
export function segmentUtterance(
  source: string,
  accepted: ReadonlyArray<BoundaryCandidate>,
): ReadonlyArray<DecisionSegment> {
  const ordered = [...accepted]
    .filter((boundary) => boundary.matchStart > 0 && boundary.matchEnd < source.length)
    .sort((left, right) => left.matchStart - right.matchStart);
  const boundaries: BoundaryCandidate[] = [];
  for (const boundary of ordered) {
    const previous = boundaries.at(-1);
    if (previous !== undefined && boundary.matchStart < previous.matchEnd) continue;
    boundaries.push(boundary);
  }
  if (boundaries.length === 0) {
    const text = source.trim();
    if (text.length === 0) return [];
    const start = source.indexOf(text);
    return [{ start, end: start + text.length, text }];
  }
  const raw: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const boundary of boundaries) {
    raw.push({ start: cursor, end: boundary.matchStart });
    cursor = boundary.matchEnd;
  }
  raw.push({ start: cursor, end: source.length });
  const segments: DecisionSegment[] = [];
  for (const range of raw) {
    const slice = source.slice(range.start, range.end);
    const leading = slice.length - slice.trimStart().length;
    const start = range.start + leading;
    const text = slice.trim();
    if (text.length === 0) continue;
    segments.push({ start, end: start + text.length, text });
  }
  if (segments.length < 2 || segments.length > CIRCE_MAX_SEGMENTS) {
    const text = source.trim();
    if (text.length === 0) return [];
    const start = source.indexOf(text);
    return [{ start, end: start + text.length, text }];
  }
  return segments;
}

export interface LocatedSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Locate a catalog name as a whole-token phrase in the source. Returns exact
 * UTF-16 offsets into the original string, or undefined when the name is not
 * present. `locate` is total: a selection that cannot be located rejects the
 * classification instead of fabricating a span.
 */
export function locateNameSpan(source: string, name: string): LocatedSpan | undefined {
  const wanted = fold(name)
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (wanted.length === 0) return undefined;
  const tokenPattern = /[\p{Letter}\p{Number}]+/gu;
  const tokens: Array<{ folded: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(source)) !== null) {
    tokens.push({
      folded: fold(match[0]),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  for (let index = 0; index + wanted.length <= tokens.length; index += 1) {
    let ok = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (tokens[index + offset]?.folded !== wanted[offset]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = tokens[index]!.start;
    const end = tokens[index + wanted.length - 1]!.end;
    return { start, end, text: source.slice(start, end) };
  }
  return undefined;
}

/**
 * Closed work verbs that can open a bounded command. Small on purpose: the
 * predicate below only decides whether a transcript is shaped like a command,
 * never which command it is. The decision tier owns classification.
 */
const BOUNDED_WORK_VERB =
  /(?:^|\s)(?:fix|add|build|create|implement|update|write|document|check|investigate|tighten|remove|run|test|examine|compare|find|locate|search|list|show|get|fetch|grab|pull|open|look|stop|cancel|focus|switch|move|reroute)\b/iu;

/**
 * Whether a transcript is shaped like a complete bounded command over a named
 * catalog project. Used to retire a stale clarification when the user stated
 * new work instead of answering. Pure and host-local: no model.
 */
export function looksLikeBoundedCommand(
  source: string,
  projectNames: ReadonlyArray<string>,
): boolean {
  if (source.trim().length === 0 || !/[\p{Letter}\p{Number}]/u.test(source)) return false;
  if (!BOUNDED_WORK_VERB.test(source)) return false;
  return projectNames.some((name) => locateNameSpan(source, name) !== undefined);
}

/**
 * Locate the full routing wrapper for a destination: the name plus a leading
 * `in|on|at|to` and optional `the`, so the derived instruction deletes the
 * whole wrapper and nothing else.
 */
export function locateDestinationWrapper(source: string, name: string): LocatedSpan | undefined {
  const nameSpan = locateNameSpan(source, name);
  if (nameSpan === undefined) return undefined;
  const before = source.slice(0, nameSpan.start);
  const match = /(?:^|\s)(in|on|at|to)\s+(?:the\s+)?$/iu.exec(before);
  if (match === null) return nameSpan;
  // Include the separator whitespace the regex consumed and a trailing comma
  // on the leading form (`In VPS, ...`) so deleting the wrapper leaves the
  // instruction without a doubled space or an orphaned comma.
  const start = match.index;
  const end = source[nameSpan.end] === "," ? nameSpan.end + 1 : nameSpan.end;
  return { start, end, text: source.slice(start, end) };
}

export function buildDecisionRequest(input: DecisionBuildInput): {
  readonly request: DecisionRequest;
  readonly table: DecisionOptionTable;
  readonly boundaries: ReadonlyArray<BoundaryCandidate>;
} {
  const table = buildOptionTable(input.catalog);
  const boundaries = candidateBoundaries(input.state.utterance);

  const projectCriteria: Record<string, string | null> = {};
  for (const project of table.projects) {
    projectCriteria[project.key] =
      project.names.length > 1 ? `Aliases: ${project.names.join(", ")}` : null;
  }
  const taskCriteria: Record<string, string | null> = {};
  for (const task of table.tasks) taskCriteria[task.key] = null;
  const providerCriteria: Record<string, string | null> = {};
  for (const provider of table.providers) providerCriteria[provider.key] = null;
  const modelCriteria: Record<string, string | null> = {};
  for (const provider of table.providers) {
    for (const model of provider.models) modelCriteria[model.key] = null;
  }
  const effortCriteria: Record<string, string | null> = {};
  for (const effort of table.efforts) effortCriteria[effort.key] = null;

  const actionCriteria: Record<string, string | null> = {};
  for (const action of CIRCE_DECISION_ACTIONS) actionCriteria[action] = ACTION_CRITERIA[action];

  const strategyCriteria: Record<string, string | null> = {};
  for (const strategy of CIRCE_RESPONSE_STRATEGIES) {
    strategyCriteria[strategy] = RESPONSE_STRATEGY_CRITERIA[strategy];
  }

  const questions: Record<string, DecisionQuestion> = {
    action: choiceQuestion("Which single action does this request ask for?", actionCriteria),
    destination_project: choiceQuestion(
      "Which project is the destination the user named, if any?",
      withNone(projectCriteria),
    ),
    destination_negated: noulQuestion(
      "Does the user rule out or forbid the named target or control?",
      "The named project or control is explicitly excluded.",
      "No project or control is ruled out.",
    ),
    task: choiceQuestion("Which task does the user mean, if any?", withNone(taskCriteria)),
    provider: choiceQuestion(
      "Which coding provider does the user request, if any?",
      withNone(providerCriteria),
    ),
    model_specified: noulQuestion(
      "Did the user name a model?",
      "A specific model was named.",
      "No model was named.",
    ),
    model: choiceQuestion("Which model did the user name?", withNone(modelCriteria)),
    effort_specified: noulQuestion(
      "Did the user name an effort or reasoning level?",
      "An effort level was named.",
      "No effort level was named.",
    ),
    effort: choiceQuestion("Which effort level did the user name?", withNone(effortCriteria)),
    is_compound: noulQuestion(
      "Does the utterance contain two or more independent commands?",
      "Two or more separate commands are joined in one turn.",
      "It is one command, however many clauses it has.",
    ),
    response_strategy: choiceQuestion("How should Circe answer this request?", strategyCriteria),
    tool: buildToolChoiceQuestion(),
    contains_approval_verdict: noulQuestion(
      "Is this a yes/no verdict on a waiting approval?",
      "It answers a pending approval.",
      "It does not answer a pending approval.",
    ),
    approval_verdict: choiceQuestion("What verdict did the user give?", {
      allow: "The user approves the waiting request.",
      deny: "The user denies the waiting request.",
      [NONE_OPTION]: "No verdict.",
    }),
    needs_clarification: noulQuestion(
      "Is the request too ambiguous to act on without asking?",
      "The host must ask before acting.",
      "The request is clear enough to act.",
    ),
  };

  for (const boundary of boundaries) {
    questions[boundary.id] = {
      type: "noul",
      instructions: `Does a new, independent command begin immediately after this boundary?\nLeft: "${boundary.left}"\nRight: "${boundary.right}"`,
      criteria: {
        true: "A separate command starts on the right side.",
        false: "The text on both sides is one command.",
      },
    };
  }

  for (const tool of CIRCE_TOOLS) {
    Object.assign(
      questions,
      buildToolArgumentQuestions(tool, {
        ...(input.locationCandidates === undefined ? {} : { location: input.locationCandidates }),
        ...(input.websiteCandidates === undefined ? {} : { website: input.websiteCandidates }),
      }),
    );
  }

  const state = {
    utterance: input.state.utterance,
    currentProject: input.state.currentProjectKey,
    focusedTask: input.state.focusedTaskKey,
    pendingRequest: input.state.pendingRequest,
    continueContext: input.state.continueContext,
    heardMention: input.state.heardMention ?? null,
    projects: table.projects.map((project) => ({
      name: project.key,
      aliases: project.names.filter((name) => name !== project.key).slice(0, 12),
    })),
    tasks: input.catalog.tasks.slice(0, MAX_TASKS).map((task) => ({
      title: task.title,
      project: task.project ?? null,
      state: task.state ?? null,
      objective: task.objective?.slice(0, 240) ?? null,
    })),
    providers: input.catalog.providers.slice(0, MAX_PROVIDERS).map((provider) => ({
      name: provider.names[0] ?? "provider",
      models: provider.models.map((model) => model.slug).slice(0, MAX_MODEL_OPTIONS),
    })),
  };

  return {
    request: { state, model: "jev-latest", questions },
    table,
    boundaries,
  };
}
