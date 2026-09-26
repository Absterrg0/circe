import type {
  CirceDeviceTarget,
  CirceInputRelation,
  CirceInteractionGoal,
  CirceInteractionOutcome,
  CirceInteractionQuestion,
  CirceInteractionState,
  CirceLookupDay,
  CirceLookupTool,
} from "@circe/contracts";
import * as DateTime from "effect/DateTime";

import { isExplicitSpokenApprovalAnswer } from "./confirmation.ts";
import { choiceAnswer, type DecisionAnswers, type DecisionRequest } from "./decision.ts";
import { looksLikeBoundedCommand } from "./decisionRequest.ts";
import { extractLocationCandidates } from "./place.ts";

/**
 * Pure transitions for the node-owned assistant interaction.
 *
 * One reducer owns the legal moves: which relation an input has to the active
 * goal, which slot an answer fills, when a question is asked, and when the
 * goal is replaced. The server adapter supplies IO (classification, lookup
 * execution, device dispatch) and persists the result; it never invents a
 * transition this module would reject.
 *
 * A revision increments on every state transition. An answer names the
 * revision it read, so two devices answering the same question cannot both
 * consume it.
 */

export type CirceLookupGoal = Extract<CirceInteractionGoal, { readonly kind: "lookup" }>;
export type CirceDeviceGoal = Extract<CirceInteractionGoal, { readonly kind: "device" }>;

export type CirceInteractionEffect =
  | {
      readonly kind: "run-lookup";
      readonly tool: CirceLookupTool;
      readonly day: CirceLookupDay;
      readonly location: string;
    }
  | {
      readonly kind: "start-device";
      readonly surface: CirceDeviceGoal["surface"];
      readonly goal: string;
    }
  | { readonly kind: "classify"; readonly source: string }
  /** A stop for project work: the client owns the task ref and executes it. */
  | { readonly kind: "stop-work" }
  | { readonly kind: "none" };

export type CirceInteractionProblem =
  | "answer-had-no-slot"
  | "answer-was-ambiguous"
  | "nothing-pending"
  | null;

export interface CirceInteractionDecision {
  readonly relation: CirceInputRelation;
  readonly state: CirceInteractionState;
  readonly effect: CirceInteractionEffect;
  readonly problem: CirceInteractionProblem;
}

/** A bare stop/cancel that answers the pending question rather than starting work. */
const BARE_CANCEL =
  /^(?:stop|stop it|stop that|cancel|cancel that|abort|never ?mind|forget it|forget that|that'?s all|no thanks|no thank you|dismiss)(?: please)?$/u;

/** Correction markers that retarget the active goal instead of starting new work. */
const CORRECTION_MARKER =
  /(?:^|\s)(?:actually|instead|rather|i meant|i said|sorry i meant|no i meant|not that|change it to|make it|update it to)(?:$|\s|,)/u;

export function isBareCancelUtterance(utterance: string): boolean {
  return BARE_CANCEL.test(utterance.trim().toLowerCase());
}

export function hasCorrectionMarker(utterance: string): boolean {
  return CORRECTION_MARKER.test(utterance.trim().toLowerCase());
}

export interface ResolveCirceInputRelationInput {
  readonly state: CirceInteractionState;
  readonly utterance: string;
  readonly projectNames?: ReadonlyArray<string>;
}

/**
 * Default relation of an input to the active interaction. A pending question
 * makes a bare answer the default; an explicit cancel or a complete new
 * command overrides it. The model may propose a different relation, but only
 * the transitions in this module are legal.
 */
export function resolveCirceInputRelation(
  input: ResolveCirceInputRelationInput,
): CirceInputRelation {
  const text = input.utterance.trim();
  if (isBareCancelUtterance(text)) return "cancel";
  const pending = input.state.pending;
  if (pending !== null && pending.kind === "approval") {
    const verdict = isExplicitSpokenApprovalAnswer(text);
    if (verdict === "accept") return "answer";
    if (verdict === "decline") return "cancel";
  }
  if (looksLikeBoundedCommand(text, input.projectNames ?? [])) return "new-request";
  // A correction retargets the active goal whether or not a question is open:
  // "actually tomorrow" after a weather answer is the same lookup, not new work.
  if (hasCorrectionMarker(text)) return "correction";
  if (pending === null) {
    // A bare place while a lookup goal is active retargets the same lookup.
    // "Springfield, Illinois" after a weather answer is the user refining the
    // place, not new work that would drop the lookup. A question-shaped input
    // stays new work.
    if (
      input.state.goal.kind === "lookup" &&
      !text.includes("?") &&
      !/^(?:what|why|how|who|when|where|which)\b/iu.test(text) &&
      answerPlaceCandidates(text).length === 1
    ) {
      return "correction";
    }
    return "new-request";
  }
  return "answer";
}

/** Whether a relation can legally apply to this state. */
export function isLegalCirceRelation(
  state: CirceInteractionState,
  relation: CirceInputRelation,
): boolean {
  switch (relation) {
    case "cancel":
      return true;
    case "answer":
      return state.pending !== null;
    case "correction":
    case "new-request":
      return true;
  }
}

/**
 * Whether the deterministic relation is uncertain enough to ask the model.
 * The common case stays model-free: a short place answer or an explicit
 * verdict resolves without a round trip.
 */
export function needsRelationDecision(state: CirceInteractionState, utterance: string): boolean {
  const text = utterance.trim();
  if (state.pending === null) return false;
  if (isBareCancelUtterance(text) || hasCorrectionMarker(text)) return false;
  if (looksLikeBoundedCommand(text, [])) return false;
  if (state.pending.kind === "approval") {
    return isExplicitSpokenApprovalAnswer(text) === undefined;
  }
  const words = text.split(/\s+/u).filter((word) => word.length > 0).length;
  if (words > 10) return true;
  if (text.includes("?")) return true;
  return /^(?:what|why|how|who|when|where|which)\b/iu.test(text);
}

export const CIRCE_INTERACTION_RELATION_QUESTION = "relation";

/** One finite request over the input's relationship to the active goal. */
export function buildInteractionRelationRequest(input: {
  readonly model: string;
  readonly state: CirceInteractionState;
  readonly utterance: string;
}): DecisionRequest {
  const pending = input.state.pending;
  return {
    model: input.model,
    state: {
      utterance: input.utterance.slice(0, 1_000),
      goalKind: input.state.goal.kind,
      ...(input.state.goal.kind === "lookup"
        ? {
            lookup: {
              tool: input.state.goal.tool,
              day: input.state.goal.day,
              ...(input.state.goal.location === undefined
                ? {}
                : { resolvedLocation: input.state.goal.location }),
            },
          }
        : {}),
      ...(input.state.goal.kind === "device"
        ? { device: { surface: input.state.goal.surface, goal: input.state.goal.goal } }
        : {}),
      pending:
        pending === null
          ? null
          : {
              kind: pending.kind,
              slot: pending.slot,
              prompt: pending.prompt,
              known: pending.known,
              choices: [...pending.choices],
            },
    },
    questions: {
      [CIRCE_INTERACTION_RELATION_QUESTION]: {
        type: "choice",
        instructions:
          "What is this utterance doing relative to the active goal and its pending question? Choose answer when it supplies the missing slot, correction when it retargets the same goal, new-request when it starts different work, and cancel when it stops the interaction.",
        criteria: {
          answer: "It supplies the value the pending question asks for.",
          correction: "It changes an argument of the same active goal.",
          "new-request": "It starts a different request that is not this goal.",
          cancel: "It stops the active goal or declines the pending question.",
        },
      },
    },
  };
}

/** Read the model-proposed relation, if it answered. */
export function readInteractionRelation(answers: DecisionAnswers): CirceInputRelation | undefined {
  const answer = choiceAnswer(answers, CIRCE_INTERACTION_RELATION_QUESTION);
  if (answer === undefined) return undefined;
  switch (answer.choice) {
    case "answer":
    case "correction":
    case "new-request":
    case "cancel":
      return answer.choice;
    default:
      return undefined;
  }
}

/**
 * Coerce an illegal or unhelpful relation to the legal one for this state. An
 * answer with nothing pending is new work; a new request retires the question.
 */
export function legalizeCirceRelation(
  state: CirceInteractionState,
  relation: CirceInputRelation,
): CirceInputRelation {
  if (relation === "answer" && state.pending === null) return "new-request";
  return relation;
}

function advanced(state: CirceInteractionState, now: DateTime.Utc): CirceInteractionState {
  return { ...state, revision: state.revision + 1, updatedAt: now };
}

export function lookupQuestion(
  goal: CirceLookupGoal,
  known: Readonly<Record<string, string>> = {},
) {
  return {
    questionId: `lookup:${goal.tool}:${goal.day}`,
    kind: "argument" as const,
    slot: "location",
    prompt: "Which city or place?",
    known: { tool: goal.tool, day: goal.day, ...known },
    choices: [],
  };
}

export interface CreateLookupInteractionInput {
  readonly interactionId: CirceInteractionState["interactionId"];
  readonly ownerNodeId: CirceInteractionState["ownerNodeId"];
  readonly tool: CirceLookupTool;
  readonly day: CirceLookupDay;
  readonly location?: string;
  readonly now: DateTime.Utc;
}

/**
 * Start a lookup interaction. A lookup without a place immediately owns a
 * question, so the place answer resumes the same lookup on any device.
 */
export function createLookupInteraction(input: CreateLookupInteractionInput): {
  readonly state: CirceInteractionState;
  readonly effect: CirceInteractionEffect;
} {
  const goal: CirceLookupGoal = {
    kind: "lookup",
    tool: input.tool,
    day: input.day,
    ...(input.location === undefined ? {} : { location: input.location }),
  };
  const state: CirceInteractionState = {
    interactionId: input.interactionId,
    ownerNodeId: input.ownerNodeId,
    revision: 0,
    goal,
    pending: input.location === undefined ? lookupQuestion(goal) : null,
    target: null,
    operationId: null,
    outcome: null,
    updatedAt: input.now,
  };
  return {
    state,
    effect:
      input.location === undefined
        ? { kind: "none" }
        : { kind: "run-lookup", tool: input.tool, day: input.day, location: input.location },
  };
}

/** Attach a question to an existing interaction. The question owns the revision. */
export function askCirceQuestion(
  state: CirceInteractionState,
  question: CirceInteractionQuestion,
  now: DateTime.Utc,
): CirceInteractionState {
  return advanced({ ...state, pending: question, outcome: null }, now);
}

export function recordCirceOutcome(
  state: CirceInteractionState,
  outcome: CirceInteractionOutcome,
  now: DateTime.Utc,
): CirceInteractionState {
  return advanced({ ...state, pending: null, outcome }, now);
}

export function bindCirceDeviceTarget(
  state: CirceInteractionState,
  target: CirceDeviceTarget,
  now: DateTime.Utc,
): CirceInteractionState {
  return advanced({ ...state, target }, now);
}

export type LookupSlotResolution =
  | {
      readonly status: "resolved";
      readonly location?: string;
      readonly day?: CirceLookupDay;
    }
  | { readonly status: "ambiguous"; readonly choices: ReadonlyArray<string> }
  | { readonly status: "missing" };

const fold = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function matchChoice(choices: ReadonlyArray<string>, utterance: string): string | undefined {
  const haystack = fold(utterance);
  if (haystack.length === 0) return undefined;
  for (const choice of choices) {
    const needle = fold(choice);
    if (needle.length === 0) continue;
    if (haystack === needle || haystack.includes(needle)) return choice;
  }
  return undefined;
}

const DAY_WORDS: ReadonlyArray<{ readonly word: string; readonly day: CirceLookupDay }> = [
  { word: "tomorrow", day: "tomorrow" },
  { word: "today", day: "today" },
  { word: "now", day: "now" },
  { word: "currently", day: "now" },
  { word: "right now", day: "now" },
];

/**
 * Conversational tokens that are never a place name on their own. A spoken
 * answer like "hmm, I think London" must yield London, and a pure backchannel
 * must yield no place at all instead of a junk geocode attempt.
 */
const ANSWER_FILLER: ReadonlySet<string> = new Set([
  "actually",
  "ask",
  "asked",
  "check",
  "checked",
  "checking",
  "cool",
  "fine",
  "great",
  "guess",
  "hello",
  "hey",
  "hmm",
  "know",
  "like",
  "look",
  "looking",
  "maybe",
  "mean",
  "meant",
  "nice",
  "no",
  "ok",
  "okay",
  "please",
  "right",
  "said",
  "say",
  "sorry",
  "sure",
  "tell",
  "thanks",
  "thank",
  "think",
  "told",
  "want",
  "wanted",
  "well",
  "yeah",
  "yes",
]);

const isAnswerFiller = (candidate: string): boolean => {
  const tokens = candidate
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => ANSWER_FILLER.has(token));
};

/** Place spans in an answer with conversational filler removed. */
function answerPlaceCandidates(utterance: string): ReadonlyArray<string> {
  return extractLocationCandidates(utterance).filter((candidate) => !isAnswerFiller(candidate));
}

/**
 * Read one answer against the question's slot. Place answers are the user's
 * own transcript spans; an offered choice wins over a fresh extraction so an
 * ambiguous-place question binds to the exact candidate the user repeated.
 */
export function resolveLookupSlotAnswer(input: {
  readonly question: CirceInteractionQuestion;
  readonly utterance: string;
}): LookupSlotResolution {
  if (input.question.slot === "day") {
    const haystack = fold(input.utterance);
    const match = DAY_WORDS.find((candidate) => haystack.includes(candidate.word));
    return match === undefined ? { status: "missing" } : { status: "resolved", day: match.day };
  }
  const offered = matchChoice(input.question.choices, input.utterance);
  if (offered !== undefined) return { status: "resolved", location: offered };
  const candidates = answerPlaceCandidates(input.utterance);
  if (candidates.length === 0) return { status: "missing" };
  if (candidates.length === 1) return { status: "resolved", location: candidates[0]! };
  return { status: "ambiguous", choices: candidates };
}

/**
 * The utterance the lookup runner may ground a place against. A location the
 * user established earlier (an answer, or an earlier turn) stays grounded: the
 * runner only accepts a place that appears in the source, so a correction that
 * changes just the day must carry the resolved place with it.
 */
export function circeLookupSourceUtterance(goal: CirceLookupGoal, utterance: string): string {
  if (goal.location === undefined) return utterance;
  const needle = fold(goal.location);
  if (needle.length === 0) return utterance;
  return fold(utterance).includes(needle) ? utterance : `${goal.location}. ${utterance}`;
}

function mergeLookupGoal(
  goal: CirceLookupGoal,
  resolution: { readonly location?: string; readonly day?: CirceLookupDay },
): CirceLookupGoal {
  const location = resolution.location ?? goal.location;
  return {
    kind: "lookup",
    tool: goal.tool,
    day: resolution.day ?? goal.day,
    ...(location === undefined ? {} : { location }),
  };
}

function lookupEffect(goal: CirceLookupGoal): CirceInteractionEffect {
  return goal.location === undefined
    ? { kind: "none" }
    : { kind: "run-lookup", tool: goal.tool, day: goal.day, location: goal.location };
}

export interface CirceInteractionDecisionInput {
  readonly state: CirceInteractionState;
  readonly utterance: string;
  readonly now: DateTime.Utc;
  readonly projectNames?: ReadonlyArray<string>;
  /** A model-proposed relation; validated against the state before use. */
  readonly proposedRelation?: CirceInputRelation;
  /**
   * Adapter-resolved slot answer, used when the content step asked the model
   * to select among candidate spans. Absent means deterministic extraction.
   */
  readonly lookupAnswer?: LookupSlotResolution;
}

/**
 * The single pure reducer. Returns the next state and the effect the adapter
 * must run. An answer that carries no slot leaves the question and revision
 * untouched so the same question can be asked again.
 */
export function decideCirceInteractionInput(
  input: CirceInteractionDecisionInput,
): CirceInteractionDecision {
  const proposed = input.proposedRelation ?? resolveCirceInputRelation(input);
  const relation = legalizeCirceRelation(
    input.state,
    isLegalCirceRelation(input.state, proposed) ? proposed : resolveCirceInputRelation(input),
  );
  const state = input.state;

  if (relation === "cancel") {
    // A stop is resolved by the owner node: it stops the task it is actually
    // running when one exists, and otherwise cancels this interaction. The
    // reducer never guesses; the node owns both facts.
    return { relation, state, effect: { kind: "stop-work" }, problem: null };
  }

  if (relation === "new-request") {
    return {
      relation,
      state: state.pending === null ? state : advanced({ ...state, pending: null }, input.now),
      effect: { kind: "classify", source: input.utterance },
      problem: null,
    };
  }

  if (relation === "correction") {
    if (state.goal.kind === "lookup") {
      const candidates = answerPlaceCandidates(input.utterance);
      const dayMatch = resolveLookupSlotAnswer({
        question: { ...lookupQuestion(state.goal), slot: "day" },
        utterance: input.utterance,
      });
      const resolution = {
        ...(candidates.length === 1 ? { location: candidates[0]! } : {}),
        ...(dayMatch.status === "resolved" && dayMatch.day !== undefined
          ? { day: dayMatch.day }
          : {}),
      };
      if (candidates.length > 1) {
        return {
          relation,
          state: askCirceQuestion(
            state,
            {
              questionId: `lookup:${state.goal.tool}:place`,
              kind: "choice",
              slot: "location",
              prompt: "Which of those places did you mean?",
              known: { tool: state.goal.tool, day: resolution.day ?? state.goal.day },
              choices: [...candidates],
            },
            input.now,
          ),
          effect: { kind: "none" },
          problem: "answer-was-ambiguous",
        };
      }
      if (resolution.location === undefined && resolution.day === undefined) {
        return {
          relation,
          state,
          effect: { kind: "none" },
          problem: "answer-had-no-slot",
        };
      }
      const goal = mergeLookupGoal(state.goal, resolution);
      const next = advanced({ ...state, goal, pending: null }, input.now);
      return { relation, state: next, effect: lookupEffect(goal), problem: null };
    }
    if (state.goal.kind === "device") {
      const next = advanced({ ...state, pending: null }, input.now);
      return {
        relation,
        state: next,
        effect: { kind: "start-device", surface: state.goal.surface, goal: input.utterance },
        problem: null,
      };
    }
    return {
      relation,
      state: state.pending === null ? state : advanced({ ...state, pending: null }, input.now),
      effect: { kind: "classify", source: input.utterance },
      problem: null,
    };
  }

  // relation === "answer"
  const pending = state.pending;
  if (pending === null) {
    return {
      relation: "new-request",
      state,
      effect: { kind: "classify", source: input.utterance },
      problem: "nothing-pending",
    };
  }

  if (pending.kind === "approval") {
    if (state.goal.kind === "device") {
      return {
        relation,
        state: advanced({ ...state, pending: null }, input.now),
        effect: { kind: "start-device", surface: state.goal.surface, goal: state.goal.goal },
        problem: null,
      };
    }
    return {
      relation,
      state: advanced({ ...state, pending: null }, input.now),
      effect: { kind: "none" },
      problem: null,
    };
  }

  if (state.goal.kind !== "lookup") {
    // A question outside a lookup goal is resolved by the adapter that owns
    // the goal (project, task, device); this reducer only records the answer.
    return {
      relation,
      state: advanced({ ...state, pending: null }, input.now),
      effect: { kind: "none" },
      problem: null,
    };
  }

  const resolution =
    input.lookupAnswer ??
    resolveLookupSlotAnswer({ question: pending, utterance: input.utterance });
  if (resolution.status === "missing") {
    return { relation, state, effect: { kind: "none" }, problem: "answer-had-no-slot" };
  }
  if (resolution.status === "ambiguous") {
    return {
      relation,
      state: askCirceQuestion(
        state,
        {
          questionId: `lookup:${state.goal.tool}:place`,
          kind: "choice",
          slot: "location",
          prompt: "Which of those places did you mean?",
          known: { tool: state.goal.tool, day: state.goal.day },
          choices: [...resolution.choices],
        },
        input.now,
      ),
      effect: { kind: "none" },
      problem: "answer-was-ambiguous",
    };
  }
  const goal = mergeLookupGoal(state.goal, resolution);
  const next = advanced({ ...state, goal, pending: null }, input.now);
  return { relation, state: next, effect: lookupEffect(goal), problem: null };
}
