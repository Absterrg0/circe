import * as Effect from "effect/Effect";

import { choiceAnswer, noulHolds, type DecisionAnswers, type DecisionRequest } from "./decision.ts";
import { NONE_OPTION } from "./toolRegistry.ts";

/**
 * The deterministic half of autonomous surface use (browser and desktop).
 *
 * A provider plans the goal; this module never lets the model invent a
 * target or a coordinate. The surface supplies a grounded element catalog
 * (browser snapshots already do; desktop supplies one once its grounding
 * layer exists). One TypeSafe decision picks a finite action kind, one
 * grounded element, and finite key/direction options, and code derives the
 * concrete action from that selection. The runner repeats capture, select,
 * apply until done, a budget runs out, or the model needs a human answer.
 *
 * Typing is the exception that cannot be a closed choice, so the text is
 * supplied by the provider plan (`typeText`), never produced by the step
 * selector. The selector only chooses where and when to type it.
 */

/** A grounded, addressable element. `id` is host-derived and stable per surface. */
export interface ComputerElement {
  readonly id: string;
  readonly role: string | null;
  readonly name: string;
  /** Owning application name, when the surface can report one. */
  readonly app?: string;
  /**
   * Current text of a field, display, or label. Without it a calculator
   * result or a typed sentence is invisible to both the selector and the
   * goal check.
   */
  readonly value?: string;
  /** Compact state names such as `checked` or `selected`. */
  readonly state?: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface ComputerSurface {
  readonly kind: "browser" | "desktop";
  readonly title: string;
  readonly url?: string;
  /** Bounded, already-safe page or window text for the selector. */
  readonly visibleText?: string;
  /**
   * The element the surface observed as focused, if any. Input may only use
   * this element or an explicitly chosen one; a missing element never falls
   * back to ambient focus.
   */
  readonly focusedElementId?: string;
  /** Monotonic observation identity; a stale handle never becomes a click. */
  readonly observationRef?: string;
  /**
   * The observation is partial: the driver reported degradation, truncation,
   * or dropped structural rows. The selector must not treat what it cannot see
   * as absent.
   */
  readonly degraded?: boolean;
  readonly elements: ReadonlyArray<ComputerElement>;
}

export const COMPUTER_ACTION_KINDS = ["click", "type", "press", "scroll", "wait", "done"] as const;
export type ComputerActionKind = (typeof COMPUTER_ACTION_KINDS)[number];

/**
 * Typing is the one value a closed step cannot pick from the surface, and a
 * voice mission has no provider plan to supply it. The text must come from the
 * user's own words, so the request offers bounded spans of the goal as a
 * closed choice and composition slices the chosen span verbatim. The model
 * never emits free text; it selects among spans code already built.
 *
 * Candidate construction is layered so the cap can never hide the intended
 * phrase: quoted spans and spans named after a search/type cue come first,
 * then the whole goal, then every token run by start position. A cap that
 * truncated a run before the user's phrase was representable would let a
 * natural wording change silently remove the correct answer.
 */
export const COMPUTER_TYPE_TEXT_MAX_RUN_TOKENS = 5;
export const COMPUTER_TYPE_TEXT_MAX_CANDIDATES = 96;
const COMPUTER_TYPE_TEXT_MAX_LENGTH = 160;

const QUOTED_TYPE_SPAN = /["'“”‘’]([^"'“”‘’]{2,160})["'“”‘’]/gu;
const TYPE_CUE =
  /(?:\bsearch(?:\s+(?:for|up))?|\blook\s+up|\bgoogle|\btype|\benter|\bwrite|\bfill(?:\s+in)?|\bfind)\b[\s:]+(.{2,160}?)(?=\s+(?:in|on|at|into|from|with|and|then|please|using|via|inside|within)\b|[,.!?;]|$)/giu;

const LEADING_BOUNDARY = new Set([
  "the",
  "a",
  "an",
  "for",
  "to",
  "in",
  "on",
  "at",
  "phrase",
  "text",
  "words",
  "word",
]);
const TRAILING_BOUNDARY = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "from",
  "in",
  "inside",
  "into",
  "my",
  "now",
  "on",
  "or",
  "our",
  "please",
  "that",
  "the",
  "their",
  "then",
  "this",
  "to",
  "using",
  "via",
  "with",
  "within",
  "your",
]);

/** Trim cue scaffolding and connective words without touching the user's own words. */
function trimBoundaryWords(value: string): string {
  const words = value.split(/\s+/u).filter((word) => word.length > 0);
  let start = 0;
  let end = words.length;
  while (start < end && LEADING_BOUNDARY.has(words[start]!.toLowerCase())) start += 1;
  while (
    end > start &&
    TRAILING_BOUNDARY.has(words[end - 1]!.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
  ) {
    end -= 1;
  }
  return words.slice(start, end).join(" ").trim();
}

export function buildTypeTextCandidates(goal: string): ReadonlyArray<string> {
  const tokens = goal.split(/\s+/).filter((token) => token.length > 0);
  const seen = new Set<string>();
  const candidates: Array<string> = [];
  const add = (value: string): void => {
    const text = value.trim();
    if (text.length < 2 || text.length > COMPUTER_TYPE_TEXT_MAX_LENGTH) return;
    if (!/[\p{Letter}\p{Number}]/u.test(text)) return;
    if (seen.has(text)) return;
    seen.add(text);
    candidates.push(text);
  };

  // 1. Explicit content: quoted spans and spans named after a type/search cue.
  const quoted = new RegExp(QUOTED_TYPE_SPAN.source, "gu");
  let quotedMatch: RegExpExecArray | null;
  while ((quotedMatch = quoted.exec(goal)) !== null) add(quotedMatch[1] ?? "");
  const cued = new RegExp(TYPE_CUE.source, "giu");
  let cueMatch: RegExpExecArray | null;
  while ((cueMatch = cued.exec(goal)) !== null) add(trimBoundaryWords(cueMatch[1] ?? ""));

  // 2. The whole goal, then every contiguous run ordered by start position so
  // every region of the sentence is representable before the cap applies.
  add(goal);
  for (let start = 0; start < tokens.length; start += 1) {
    for (
      let length = Math.min(COMPUTER_TYPE_TEXT_MAX_RUN_TOKENS, tokens.length - start);
      length >= 1;
      length -= 1
    ) {
      add(tokens.slice(start, start + length).join(" "));
      if (candidates.length >= COMPUTER_TYPE_TEXT_MAX_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

/** Kept in step with `desktopUse/policy.ts` allowed keys. */
export const COMPUTER_PRESS_KEYS = [
  "enter",
  "tab",
  "escape",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "backspace",
  "pageup",
  "pagedown",
] as const;
export type ComputerPressKey = (typeof COMPUTER_PRESS_KEYS)[number];

export const COMPUTER_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type ComputerScrollDirection = (typeof COMPUTER_SCROLL_DIRECTIONS)[number];

/** The concrete, host-resolvable action derived from one selection. */
export type ComputerAction =
  | { readonly kind: "click"; readonly elementId: string }
  | { readonly kind: "type"; readonly elementId: string; readonly text: string }
  | { readonly kind: "press"; readonly elementId: string; readonly key: ComputerPressKey }
  | { readonly kind: "scroll"; readonly direction: ComputerScrollDirection }
  | { readonly kind: "wait" };

export type ComputerStepRefusal = "confidence-too-low" | "unknown-element" | "missing-parameter";

export type ComputerStep =
  | { readonly kind: "action"; readonly action: ComputerAction }
  | { readonly kind: "done"; readonly summary: string }
  | { readonly kind: "refused"; readonly reason: ComputerStepRefusal };

export const COMPUTER_STEP_CONFIDENCE_FLOOR = 0.55;
export const COMPUTER_STEP_DEFAULT_MAX_ELEMENTS = 60;
export const COMPUTER_STEP_MAX_VISIBLE_TEXT = 4_000;

const ELEMENT_QUESTION = "element";
const ACTION_QUESTION = "action";
const PRESS_KEY_QUESTION = "press_key";
const SCROLL_DIRECTION_QUESTION = "scroll_direction";
const TYPE_TEXT_QUESTION = "type_text";

const ACTION_CRITERIA: Readonly<Record<string, string>> = {
  click: "Press the chosen element once.",
  type: "Enter the planned text into the chosen element.",
  press: "Press one named key on the chosen element.",
  scroll: "Scroll the surface in one direction.",
  wait: "Let the surface settle before looking again.",
  done: "The goal is already satisfied; stop.",
};

const elementLabel = (element: ComputerElement): string =>
  `${element.app === undefined ? "" : `${element.app}: `}${element.role ?? "element"}: ${element.name}${
    element.value === undefined || element.value.length === 0
      ? ""
      : ` = ${JSON.stringify(element.value.slice(0, 80))}`
  }${element.state === undefined ? "" : ` (${element.state})`}`.slice(0, 240);

export interface BuildComputerStepRequestInput {
  readonly model: string;
  readonly goal: string;
  readonly surface: ComputerSurface;
  /** Provider-supplied text for a type action; enables the action when present. */
  readonly typeText?: string;
  readonly history?: ReadonlyArray<string>;
  readonly maxElements?: number;
  /**
   * Whether the observed surface differs from mission start, and whether the
   * last applied action changed it. A step model that cannot see its own
   * no-ops repeats them until the budget runs out.
   */
  readonly surfaceChangedSinceStart?: boolean;
  readonly surfaceChangedAfterLastAction?: boolean;
}

function boundedSurface(surface: ComputerSurface, maxElements: number) {
  return {
    kind: surface.kind,
    title: surface.title.slice(0, 240),
    ...(surface.url === undefined ? {} : { url: surface.url.slice(0, 2048) }),
    ...(surface.visibleText === undefined
      ? {}
      : { visibleText: surface.visibleText.slice(0, COMPUTER_STEP_MAX_VISIBLE_TEXT) }),
    // A partial observation must reach the selector and the verifier: what the
    // tree cannot show is unknown, not absent.
    ...(surface.degraded === true ? { degraded: true } : {}),
    elementCount: surface.elements.length,
    elements: surface.elements.slice(0, maxElements).map((element) => ({
      id: element.id,
      role: element.role,
      name: element.name.slice(0, 200),
      ...(element.app === undefined ? {} : { app: element.app.slice(0, 80) }),
      ...(element.value === undefined ? {} : { value: element.value.slice(0, 120) }),
      ...(element.state === undefined ? {} : { state: element.state.slice(0, 80) }),
    })),
  };
}

/**
 * One finite request over the next action. Element ids and finite key and
 * direction sets are the only targets; the model never emits a coordinate,
 * a selector, or free text.
 */
export function buildComputerStepRequest(input: BuildComputerStepRequestInput): DecisionRequest {
  const maxElements = input.maxElements ?? COMPUTER_STEP_DEFAULT_MAX_ELEMENTS;
  const elements = input.surface.elements.slice(0, maxElements);
  const typeTextCandidates =
    input.typeText === undefined ? buildTypeTextCandidates(input.goal) : [];
  const actionKinds = COMPUTER_ACTION_KINDS.filter(
    (kind) => kind !== "type" || input.typeText !== undefined || typeTextCandidates.length > 0,
  );
  const actionCriteria: Record<string, string | null> = {};
  for (const kind of actionKinds) actionCriteria[kind] = ACTION_CRITERIA[kind] ?? null;

  const elementCriteria: Record<string, string | null> = {};
  if (elements.length > 0) {
    for (const element of elements) elementCriteria[element.id] = elementLabel(element);
    elementCriteria[NONE_OPTION] = "No element; act on the focused or whole surface.";
  }

  const pressCriteria: Record<string, string | null> = {};
  for (const key of COMPUTER_PRESS_KEYS) pressCriteria[key] = null;

  const scrollCriteria: Record<string, string | null> = {};
  for (const direction of COMPUTER_SCROLL_DIRECTIONS) scrollCriteria[direction] = null;

  const questions: Record<string, DecisionRequest["questions"][string]> = {
    [ACTION_QUESTION]: {
      type: "choice",
      instructions:
        "Which single next action moves the goal forward? A control that exists on screen is not a result: when the goal says to click, open, go to, or change something, choose the action that does it. Choose done only when the surface already shows the goal's result.",
      criteria: actionCriteria,
    },
    [PRESS_KEY_QUESTION]: {
      type: "choice",
      instructions: "Which named key should be pressed when the action is press?",
      criteria: pressCriteria,
    },
    [SCROLL_DIRECTION_QUESTION]: {
      type: "choice",
      instructions: "Which direction should the surface scroll when the action is scroll?",
      criteria: scrollCriteria,
    },
  };
  if (elements.length > 0) {
    questions[ELEMENT_QUESTION] = {
      type: "choice",
      instructions:
        "Which grounded element should the action target? Choose none only when no element applies.",
      criteria: elementCriteria,
    };
  }
  if (typeTextCandidates.length > 0) {
    const typeTextCriteria: Record<string, string | null> = {};
    for (const candidate of typeTextCandidates) typeTextCriteria[candidate] = null;
    questions[TYPE_TEXT_QUESTION] = {
      type: "choice",
      instructions:
        "When the action is type, which span of the goal is the exact text to enter? Choose one of the user's own phrases, or none when no span applies.",
      criteria: typeTextCriteria,
    };
  }

  return {
    model: input.model,
    state: {
      goal: input.goal.slice(0, 1_000),
      ...(input.surfaceChangedSinceStart === undefined
        ? {}
        : { surfaceChangedSinceStart: input.surfaceChangedSinceStart }),
      ...(input.surfaceChangedAfterLastAction === undefined
        ? {}
        : { surfaceChangedAfterLastAction: input.surfaceChangedAfterLastAction }),
      surface: boundedSurface(input.surface, maxElements),
      history: (input.history ?? []).slice(-12),
    },
    questions,
  };
}

export interface ComposeComputerStepInput {
  readonly goal: string;
  readonly surface: ComputerSurface;
  readonly answers: DecisionAnswers;
  readonly typeText?: string;
}

function selectedElement(
  surface: ComputerSurface,
  answers: DecisionAnswers,
):
  | { readonly status: "element"; readonly id: string }
  | { readonly status: "none" }
  | { readonly status: "unknown" } {
  const answer = choiceAnswer(answers, ELEMENT_QUESTION);
  if (answer === undefined || answer.confidence < COMPUTER_STEP_CONFIDENCE_FLOOR) {
    return { status: "none" };
  }
  if (answer.choice === NONE_OPTION) return { status: "none" };
  return surface.elements.some((element) => element.id === answer.choice)
    ? { status: "element", id: answer.choice }
    : { status: "unknown" };
}

/**
 * The element an input action may touch. Only an explicitly chosen element or
 * the element the observation reported as focused is legal; nothing falls back
 * to whatever happens to have ambient focus.
 */
function inputTarget(
  surface: ComputerSurface,
  answers: DecisionAnswers,
):
  | { readonly status: "element"; readonly id: string }
  | { readonly status: "missing" }
  | { readonly status: "unknown" } {
  const element = selectedElement(surface, answers);
  if (element.status === "unknown") return { status: "unknown" };
  if (element.status === "element") return element;
  const focused = surface.focusedElementId;
  if (focused !== undefined && surface.elements.some((element) => element.id === focused)) {
    return { status: "element", id: focused };
  }
  return { status: "missing" };
}

function readChoice(answers: DecisionAnswers, id: string): string | undefined {
  const answer = choiceAnswer(answers, id);
  if (answer === undefined || answer.confidence < COMPUTER_STEP_CONFIDENCE_FLOOR) return undefined;
  return answer.choice;
}

const isPressKey = (value: string): value is ComputerPressKey =>
  (COMPUTER_PRESS_KEYS as ReadonlyArray<string>).includes(value);

const isScrollDirection = (value: string): value is ComputerScrollDirection =>
  (COMPUTER_SCROLL_DIRECTIONS as ReadonlyArray<string>).includes(value);

/** Derive the grounded action from one selection, or refuse. */
export function composeComputerStep(input: ComposeComputerStepInput): ComputerStep {
  const action = readChoice(input.answers, ACTION_QUESTION);
  if (action === undefined) return { kind: "refused", reason: "confidence-too-low" };

  if (action === "done") {
    return { kind: "done", summary: input.goal.slice(0, 240) };
  }

  if (action === "click") {
    const element = selectedElement(input.surface, input.answers);
    if (element.status === "unknown") return { kind: "refused", reason: "unknown-element" };
    if (element.status !== "element") return { kind: "refused", reason: "missing-parameter" };
    return { kind: "action", action: { kind: "click", elementId: element.id } };
  }

  if (action === "type") {
    // Planned text wins; a voice mission has none, so the text must be a span
    // of the user's own goal that code slices verbatim.
    let text = input.typeText;
    if (text === undefined || text.length === 0) {
      const chosen = readChoice(input.answers, TYPE_TEXT_QUESTION);
      const candidates = buildTypeTextCandidates(input.goal);
      if (chosen === undefined || chosen === NONE_OPTION || !candidates.includes(chosen)) {
        return { kind: "refused", reason: "missing-parameter" };
      }
      text = chosen;
    }
    const target = inputTarget(input.surface, input.answers);
    if (target.status === "unknown") return { kind: "refused", reason: "unknown-element" };
    if (target.status === "missing") return { kind: "refused", reason: "missing-parameter" };
    return { kind: "action", action: { kind: "type", elementId: target.id, text } };
  }

  if (action === "press") {
    const key = readChoice(input.answers, PRESS_KEY_QUESTION);
    if (key === undefined || !isPressKey(key))
      return { kind: "refused", reason: "missing-parameter" };
    const target = inputTarget(input.surface, input.answers);
    if (target.status === "unknown") return { kind: "refused", reason: "unknown-element" };
    if (target.status === "missing") return { kind: "refused", reason: "missing-parameter" };
    return { kind: "action", action: { kind: "press", elementId: target.id, key } };
  }

  if (action === "scroll") {
    const direction = readChoice(input.answers, SCROLL_DIRECTION_QUESTION);
    if (direction === undefined || !isScrollDirection(direction)) {
      return { kind: "refused", reason: "missing-parameter" };
    }
    return { kind: "action", action: { kind: "scroll", direction } };
  }

  if (action === "wait") return { kind: "action", action: { kind: "wait" } };

  return { kind: "refused", reason: "confidence-too-low" };
}

/**
 * Identity of an observation for change detection. Element ids are positional
 * paths that shift when the tree changes, so only the visible identity counts.
 */
const computerSurfaceDigest = (surface: ComputerSurface): string =>
  surface.elements
    .map(
      (element) =>
        `${element.role ?? ""}\u0001${element.name}\u0001${element.app ?? ""}\u0001${element.value ?? ""}\u0001${element.state ?? ""}`,
    )
    .join("\u0002");

/** One-line history entry for the next step's prompt. */
export function describeComputerAction(action: ComputerAction): string {
  switch (action.kind) {
    case "click":
      return `clicked ${action.elementId}`;
    case "type":
      return `typed "${action.text.slice(0, 60)}" into ${action.elementId}`;
    case "press":
      return `pressed ${action.key} on ${action.elementId}`;
    case "scroll":
      return `scrolled ${action.direction}`;
    case "wait":
      return "waited for the surface to settle";
  }
}

export interface ComputerUseRuntime<E = never> {
  readonly capture: () => Effect.Effect<ComputerSurface, E>;
  readonly select: (request: DecisionRequest) => Effect.Effect<DecisionAnswers, E>;
  /**
   * Apply one grounded action. Returns false when the action could not be
   * applied to the observed surface (missing or stale target); the caller
   * must not count that as an effect.
   */
  readonly apply: (
    action: ComputerAction,
    context?: { readonly observationRef?: string },
  ) => Effect.Effect<boolean, E>;
}

/**
 * One bounded recovery step proposed by a provider after the step loop
 * stalls. The host validates every step against the current surface before it
 * applies anything, so a plan can only name elements and keys the observation
 * actually offered.
 */
export type ComputerRecoveryStep =
  | { readonly kind: "click"; readonly elementId: string }
  | { readonly kind: "type"; readonly elementId: string; readonly text: string }
  | { readonly kind: "press"; readonly elementId: string; readonly key: ComputerPressKey }
  | { readonly kind: "scroll"; readonly direction: ComputerScrollDirection }
  | { readonly kind: "wait" };

export const COMPUTER_RECOVERY_MAX_STEPS = 4;

/** Ground one planned step against an observed surface; null when it is invalid. */
export function validateRecoveryStep(
  step: ComputerRecoveryStep,
  surface: ComputerSurface,
): ComputerAction | null {
  switch (step.kind) {
    case "click":
      return surface.elements.some((element) => element.id === step.elementId)
        ? { kind: "click", elementId: step.elementId }
        : null;
    case "type":
      return step.text.length > 0 &&
        surface.elements.some((element) => element.id === step.elementId)
        ? { kind: "type", elementId: step.elementId, text: step.text }
        : null;
    case "press":
      return (COMPUTER_PRESS_KEYS as ReadonlyArray<string>).includes(step.key) &&
        surface.elements.some((element) => element.id === step.elementId)
        ? { kind: "press", elementId: step.elementId, key: step.key }
        : null;
    case "scroll":
      return (COMPUTER_SCROLL_DIRECTIONS as ReadonlyArray<string>).includes(step.direction)
        ? { kind: "scroll", direction: step.direction }
        : null;
    case "wait":
      return { kind: "wait" };
  }
}

/**
 * Validate only the prefix that is executable as written. A step that cannot
 * run makes every later step's precondition unknown, so the remainder is
 * rejected instead of being silently filtered into a different plan: "type
 * into a missing field, then click Save" must not become "click Save".
 */
export function validateRecoveryPrefix(
  steps: ReadonlyArray<ComputerRecoveryStep>,
  surface: ComputerSurface,
): ReadonlyArray<ComputerRecoveryStep> {
  const accepted: Array<ComputerRecoveryStep> = [];
  for (const step of steps.slice(0, COMPUTER_RECOVERY_MAX_STEPS)) {
    if (validateRecoveryStep(step, surface) === null) break;
    accepted.push(step);
  }
  return accepted;
}

/**
 * A semantic plan step: it names a control by role and name, never by an
 * observation id. The host resolves each step against the surface captured
 * when the step becomes eligible, so a plan cannot replay stale handles after
 * a navigation or dialog changes the tree.
 */
export interface ComputerPlanStep {
  readonly intent: string;
  readonly action: "click" | "type" | "press" | "scroll" | "wait";
  readonly targetRole?: string | null | undefined;
  readonly targetName?: string | undefined;
  readonly text?: string | undefined;
  readonly key?: string | undefined;
  readonly direction?: string | undefined;
  /** What the planner expects to hold before the step runs, in words. */
  readonly precondition?: string | undefined;
  /** What the surface must show after the step, in words or a value. */
  readonly postcondition?: string | undefined;
}

export const COMPUTER_PLAN_MAX_STEPS = 6;
/** Plans requested per run: the first plan plus at most one replan. */
export const COMPUTER_PLAN_MAX_REQUESTS = 2;

export interface ComputerPlanInput {
  readonly goal: string;
  readonly surface: ComputerSurface;
  readonly history: ReadonlyArray<string>;
  readonly expectation: ComputerExpectation;
  /** Why a plan is needed now: "start", "target-missing", "no-effect". */
  readonly reason: "start" | "target-missing" | "no-effect";
}

const foldPlanName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Resolve one semantic step against the current surface. Exactly one matching
 * control is required: an ambiguous name is a refusal, never a guess.
 */
export function resolvePlanStep(
  step: ComputerPlanStep,
  surface: ComputerSurface,
): ComputerAction | null {
  if (step.action === "wait") return { kind: "wait" };
  if (step.action === "scroll") {
    return (COMPUTER_SCROLL_DIRECTIONS as ReadonlyArray<string>).includes(step.direction ?? "")
      ? { kind: "scroll", direction: step.direction as ComputerScrollDirection }
      : null;
  }
  const wanted = foldPlanName(step.targetName ?? "");
  if (wanted.length === 0) return null;
  const roleFilter =
    step.targetRole === undefined || step.targetRole === null
      ? null
      : foldPlanName(step.targetRole);
  const named = surface.elements.filter(
    (element) => element.role !== "frame" && element.role !== "window",
  );
  const roleMatched =
    roleFilter === null
      ? named
      : named.filter((element) => foldPlanName(element.role ?? "").includes(roleFilter));
  const candidates = roleMatched.length > 0 ? roleMatched : named;
  const exact = candidates.filter((element) => foldPlanName(element.name) === wanted);
  const matches =
    exact.length > 0
      ? exact
      : candidates.filter((element) => {
          const name = foldPlanName(element.name);
          return name.length >= 2 && (name.includes(wanted) || wanted.includes(name));
        });
  if (matches.length !== 1) return null;
  const element = matches[0]!;
  switch (step.action) {
    case "click":
      return { kind: "click", elementId: element.id };
    case "type":
      return step.text !== undefined && step.text.length > 0
        ? { kind: "type", elementId: element.id, text: step.text }
        : null;
    case "press":
      return (COMPUTER_PRESS_KEYS as ReadonlyArray<string>).includes(step.key ?? "")
        ? { kind: "press", elementId: element.id, key: step.key as ComputerPressKey }
        : null;
  }
}

export interface ComputerRecoveryInput {
  readonly goal: string;
  readonly surface: ComputerSurface;
  readonly history: ReadonlyArray<string>;
  readonly reason: "budget-exhausted" | "refused";
}

/**
 * What kind of completion a goal asks for. A single click needs evidence of
 * that activation; a display goal needs the value it names; a save goal needs
 * saved-content evidence. One generic "did the screen change?" cannot decide
 * all three.
 */
export type ComputerExpectation =
  | {
      /** The action itself is the goal: applying it once is completion. */
      readonly kind: "action";
      readonly target: string;
    }
  | {
      /** The observable state must show the value the goal names. */
      readonly kind: "state";
      readonly want: string;
    }
  | {
      /** An artifact must exist or its content must be saved. */
      readonly kind: "artifact";
      readonly what: string;
    };

const EXPECTATION_ACTION = /^\s*(?:please\s+)?(?:click|press|tap|hit|select)\b/iu;
const EXPECTATION_ARTIFACT = /\b(?:save|saved|export|download|write\s+to|create)\b/iu;
const EXPECTATION_STATE =
  /\b(?:show|shows|show(?:ing)?|display|displays|make\s+.+\s+(?:show|read|say|equal)|set\s+.+\s+to|equal|equals)\b/iu;

/**
 * The expectation a goal implies when the caller does not supply one. The
 * default is `state`: the surface must show the named result, which is the
 * strictest reading and never claims a bare activation.
 */
export function inferComputerExpectation(goal: string): ComputerExpectation {
  const text = goal.trim();
  const action = EXPECTATION_ACTION.exec(text);
  if (action !== null) {
    const target = text
      .slice(action[0].length)
      .replace(/\s+/gu, " ")
      .replace(/^(?:on\s+)?(?:the\s+|a\s+|an\s+)?/iu, "")
      .trim();
    return { kind: "action", target: target.slice(0, 120) };
  }
  if (EXPECTATION_ARTIFACT.test(text)) {
    return { kind: "artifact", what: text.slice(0, 160) };
  }
  if (EXPECTATION_STATE.test(text)) {
    return { kind: "state", want: text.slice(0, 160) };
  }
  return { kind: "state", want: text.slice(0, 160) };
}

export interface ComputerUseVerificationInput {
  readonly goal: string;
  readonly surface: ComputerSurface;
  readonly history: ReadonlyArray<string>;
  readonly summary: string;
  /**
   * Whether the observed surface differs from the one captured at mission
   * start. False means nothing visible has happened yet, so a completion
   * claim has no evidence.
   */
  readonly surfaceChangedSinceStart?: boolean;
  /**
   * Whether the last applied click or key press changed the observation.
   * False means the action was a no-op; the goal can still be satisfied if
   * the result was already visible, and only the goal check can tell.
   */
  readonly surfaceChangedAfterLastAction?: boolean;
  /** The completion kind this goal asks for; absent means `state`. */
  readonly expectation?: ComputerExpectation;
}

export interface ComputerUseRunInput<E = never> {
  readonly model: string;
  readonly goal: string;
  readonly runtime: ComputerUseRuntime<E>;
  readonly typeText?: string;
  readonly maxSteps?: number;
  readonly maxElements?: number;
  readonly onStep?: (step: ComputerStep, index: number) => Effect.Effect<void, E>;
  /** Checked between steps and again immediately before every mutation. */
  readonly shouldStop?: () => Effect.Effect<boolean, E>;
  /** The completion kind this goal asks for; absent means infer from the goal. */
  readonly expectation?: ComputerExpectation;
  /**
   * History from work already applied before the loop started (a shortcut
   * whose effect was not observed). An applied-but-unobserved action is
   * carried forward, never reset into an untouched mission.
   */
  readonly initialHistory?: ReadonlyArray<string>;
  /** Applied-action count from that earlier work. */
  readonly initialApplied?: number;
  /**
   * Goal-specific result check. When supplied, a `done` is only accepted if it
   * confirms the goal against a fresh surface; otherwise the run reports
   * unverified instead of claiming success.
   */
  readonly verify?: (input: ComputerUseVerificationInput) => Effect.Effect<boolean, E>;
  /**
   * Bounded recovery when the loop stalls. Called at most once per run with
   * the observed surface and the stall reason; the returned steps are grounded
   * against that surface before any of them is applied.
   */
  readonly replan?: (
    input: ComputerRecoveryInput,
  ) => Effect.Effect<ReadonlyArray<ComputerRecoveryStep>, E>;
  /**
   * One short semantic plan for the mission. Steps name controls by role and
   * name and are resolved against a fresh surface when each becomes eligible,
   * so a plan survives navigation and dialogs without replaying stale ids.
   */
  readonly plan?: (input: ComputerPlanInput) => Effect.Effect<ReadonlyArray<ComputerPlanStep>, E>;
}

export const COMPUTER_USE_DEFAULT_MAX_STEPS = 24;

const VERIFICATION_QUESTION = "goal_reached";
export const COMPUTER_VERIFICATION_CONFIDENCE_FLOOR = 0.7;

/**
 * A separate, goal-specific result check. The step selector decides what to do
 * next; this request decides whether the observed state actually proves the
 * goal is done. The two are asked separately because a later question cannot
 * depend on an earlier answer inside one batch, and because "done" without
 * observed evidence is the false-completion failure this guards.
 */
export function buildComputerVerificationRequest(input: {
  readonly model: string;
  readonly goal: string;
  readonly surface: ComputerSurface;
  readonly history: ReadonlyArray<string>;
  readonly summary: string;
  readonly maxElements?: number;
  readonly surfaceChangedSinceStart?: boolean;
  readonly surfaceChangedAfterLastAction?: boolean;
  readonly expectation?: ComputerExpectation;
}): DecisionRequest {
  const maxElements = input.maxElements ?? COMPUTER_STEP_DEFAULT_MAX_ELEMENTS;
  const expectation = input.expectation ?? inferComputerExpectation(input.goal);
  return {
    model: input.model,
    state: {
      goal: input.goal.slice(0, 1_000),
      claimedOutcome: input.summary.slice(0, 400),
      expectation: expectation.kind,
      ...(input.surfaceChangedSinceStart === undefined
        ? {}
        : { surfaceChangedSinceStart: input.surfaceChangedSinceStart }),
      ...(input.surfaceChangedAfterLastAction === undefined
        ? {}
        : { surfaceChangedAfterLastAction: input.surfaceChangedAfterLastAction }),
      surface: boundedSurface(input.surface, maxElements),
      history: input.history.slice(-12),
    },
    questions: {
      [VERIFICATION_QUESTION]: {
        type: "noul",
        instructions:
          "Does the observed surface itself prove the goal is already satisfied? Answer true only when the current page or window state shows the result. A control the goal would use, or a name the goal mentions, is not the result. surfaceChangedAfterLastAction=false means the last action changed nothing, so the result must already be visible in the observed state. expectation=state needs the named value visible; expectation=artifact needs saved or created content visible. A plan, an intention, an absence of errors, or the model's own claim is not proof.",
        criteria: {
          true: "The observed state proves the goal is satisfied.",
          false: "The observed state does not prove the goal is satisfied.",
        },
      },
    },
  };
}

/** Read the verification verdict; undefined when the check did not answer. */
export function computerGoalVerified(answers: DecisionAnswers): boolean | undefined {
  return noulHolds(answers, VERIFICATION_QUESTION, COMPUTER_VERIFICATION_CONFIDENCE_FLOOR);
}

export type ComputerUseRunResult =
  | {
      readonly status: "done";
      readonly steps: number;
      readonly summary: string;
      /** True when the completion was confirmed by the goal-specific check. */
      readonly verified: boolean;
    }
  /**
   * The selector reported done without an observable effect, or the result
   * check did not confirm it. The claim is reported, not accepted: nothing
   * observable backs it, so the caller must not present it as completed.
   */
  | {
      readonly status: "unverified";
      readonly steps: number;
      readonly summary: string;
      readonly reason: "no-effect" | "verification-failed" | "no-progress";
    }
  | { readonly status: "budget-exhausted"; readonly steps: number }
  | { readonly status: "cancelled"; readonly steps: number }
  | { readonly status: "refused"; readonly reason: ComputerStepRefusal; readonly steps: number };

/**
 * Capture, select, apply, repeat. Every step starts from a fresh surface so a
 * selection always binds to the state the model just saw, and the same
 * surface shape serves browser and desktop once both provide grounding.
 *
 * Cancellation is checked before the capture, after the selection, and again
 * immediately before the mutation, so a stop that arrives while the model is
 * deciding cannot be followed by a new physical action.
 */
export const runComputerUse = <E = never>(
  input: ComputerUseRunInput<E>,
): Effect.Effect<ComputerUseRunResult, E> =>
  Effect.gen(function* () {
    const initialMaxSteps = input.maxSteps ?? COMPUTER_USE_DEFAULT_MAX_STEPS;
    const hardCap = initialMaxSteps * 2;
    let maxSteps = initialMaxSteps;
    const maxElements = input.maxElements ?? COMPUTER_STEP_DEFAULT_MAX_ELEMENTS;
    const history: Array<string> = [...(input.initialHistory ?? [])];
    let applied = input.initialApplied ?? 0;
    const expectation = input.expectation ?? inferComputerExpectation(input.goal);
    let replanned = false;
    let lastSurface: ComputerSurface | null = null;
    let currentDigest: string | undefined;
    let startDigest: string | undefined;
    /**
     * The observation the last applied click or key press was composed
     * against. Comparing the newest observation with this, not with the
     * previous iteration, keeps a later failed action from hiding an earlier
     * real effect.
     */
    let lastAppliedBaseDigest: string | undefined;
    /** Recovery steps waiting for their own fresh observation. */
    let pendingRecovery: ReadonlyArray<ComputerRecoveryStep> = [];
    /** Semantic plan steps waiting for their own fresh surface. */
    let pendingPlan: ReadonlyArray<ComputerPlanStep> = [];
    let plansRequested = 0;
    let planRequested = false;
    let planReason: ComputerPlanInput["reason"] = "start";
    let awaitingPlanStep: ComputerPlanStep | undefined;
    let planExecuted = false;
    // Consecutive applied actions that changed nothing: the loop stops asking
    // the model to repeat itself and reports the stall in code.
    let noProgress = 0;

    /**
     * One bounded provider recovery per run. The plan is grounded against the
     * surface the selector just saw, so a recovered step can only name an
     * element the observation offered; a stop is still checked before each
     * recovered mutation.
     */
    const recover = Effect.fn("runComputerUse.recover")(function* (
      reason: "budget-exhausted" | "refused",
    ) {
      if (input.replan === undefined || replanned || lastSurface === null) return false;
      replanned = true;
      const steps = yield* input.replan({
        goal: input.goal,
        surface: lastSurface,
        history: [...history],
        reason,
      });
      const accepted = validateRecoveryPrefix(steps, lastSurface);
      if (accepted.length === 0) return false;
      // The plan is a queue, not a batch: each step is revalidated against a
      // fresh observation and applied through the loop's own stop gates.
      pendingRecovery = accepted;
      maxSteps = Math.min(maxSteps + accepted.length, hardCap);
      return true;
    });

    let index = 0;
    while (index < maxSteps) {
      if (input.shouldStop !== undefined && (yield* input.shouldStop())) {
        return { status: "cancelled", steps: index } as const;
      }
      // Bound the surface once and share it with composition, so an answer can
      // only name an element the request actually offered.
      const captured = yield* input.runtime.capture();
      const surface: ComputerSurface = {
        ...captured,
        elements: captured.elements.slice(0, maxElements),
      };
      lastSurface = surface;
      currentDigest = computerSurfaceDigest(surface);
      if (startDigest === undefined) startDigest = currentDigest;
      const surfaceChangedSinceStart =
        startDigest === undefined || currentDigest === undefined
          ? undefined
          : currentDigest !== startDigest;
      const surfaceChangedAfterLastAction =
        lastAppliedBaseDigest === undefined || currentDigest === undefined
          ? undefined
          : currentDigest !== lastAppliedBaseDigest;
      // A plan step whose action changed nothing did not meet its
      // postcondition: drop the rest of the plan and ask for one replan.
      if (
        awaitingPlanStep !== undefined &&
        awaitingPlanStep.action !== "wait" &&
        surfaceChangedAfterLastAction === false
      ) {
        awaitingPlanStep = undefined;
        pendingPlan = [];
        planReason = "no-effect";
        planRequested = pendingRecovery.length === 0 && plansRequested < COMPUTER_PLAN_MAX_REQUESTS;
      }
      if (awaitingPlanStep !== undefined) awaitingPlanStep = undefined;
      // Repeated no-progress in code, not another model round trip.
      if (surfaceChangedAfterLastAction === false && lastAppliedBaseDigest !== undefined) {
        noProgress += 1;
        if (noProgress >= 2) {
          return {
            status: "unverified",
            steps: index + 1,
            summary: `I acted twice without the screen changing while trying to ${input.goal}.`,
            reason: "no-progress",
          } as const;
        }
      } else {
        noProgress = 0;
      }
      let step: ComputerStep | undefined;
      let stepOrigin: "planned" | "recovered" | null = null;
      if (input.plan !== undefined && pendingRecovery.length === 0) {
        if (pendingPlan.length === 0 && plansRequested < COMPUTER_PLAN_MAX_REQUESTS) {
          // One plan at the start, one replan after a step failed to land.
          if (plansRequested === 0 || planRequested) {
            planRequested = false;
            plansRequested += 1;
            const planned = yield* input.plan({
              goal: input.goal,
              surface,
              history,
              expectation,
              reason: plansRequested === 1 ? "start" : planReason,
            });
            pendingPlan = planned.slice(0, COMPUTER_PLAN_MAX_STEPS);
          }
        }
        const head = pendingPlan[0];
        if (head !== undefined) {
          const planned = resolvePlanStep(head, surface);
          if (planned === null) {
            // The named control is absent or ambiguous on the fresh surface:
            // the remainder of the plan is not executable either.
            pendingPlan = [];
            planReason = "target-missing";
            planRequested = plansRequested < COMPUTER_PLAN_MAX_REQUESTS;
          } else {
            pendingPlan = pendingPlan.slice(1);
            awaitingPlanStep = head;
            planExecuted = true;
            step = { kind: "action", action: planned };
            stepOrigin = "planned";
          }
        }
      }
      // A step that failed to resolve leaves the plan unusable; go back for
      // one replan against the fresh surface instead of asking the model to
      // improvise a step the planner already owns.
      if (step === undefined && planRequested && plansRequested < COMPUTER_PLAN_MAX_REQUESTS) {
        index += 1;
        continue;
      }
      // A finished plan is checked against the surface, not against another
      // model claim: the plan already chose every control.
      if (step === undefined && planExecuted && pendingPlan.length === 0) {
        const surfaceChangedSincePlan =
          startDigest === undefined || currentDigest === undefined
            ? undefined
            : currentDigest !== startDigest;
        const verified =
          input.verify === undefined
            ? true
            : yield* input.verify({
                goal: input.goal,
                surface,
                history,
                summary: input.goal,
                expectation,
                ...(surfaceChangedSincePlan === undefined
                  ? {}
                  : { surfaceChangedSinceStart: surfaceChangedSincePlan }),
              });
        if (verified) {
          return {
            status: "done",
            steps: index + 1,
            summary: `Done: ${input.goal}`,
            verified: true,
          } as const;
        }
        if (plansRequested < COMPUTER_PLAN_MAX_REQUESTS) {
          planRequested = true;
          planReason = "no-effect";
          planExecuted = false;
          index += 1;
          continue;
        }
        return {
          status: "unverified",
          steps: index + 1,
          summary: `I followed the plan but the screen did not show ${input.goal}.`,
          reason: "verification-failed",
        } as const;
      }
      if (step === undefined && pendingRecovery.length > 0) {
        const [head, ...rest] = pendingRecovery;
        const action = head === undefined ? null : validateRecoveryStep(head, surface);
        if (action === null) {
          // The precondition broke; the rest of the plan is not executable.
          pendingRecovery = [];
        } else {
          pendingRecovery = rest;
          stepOrigin = "recovered";
          step = { kind: "action", action };
        }
      }
      if (step === undefined) {
        const request = buildComputerStepRequest({
          model: input.model,
          goal: input.goal,
          surface,
          maxElements,
          ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
          history,
          ...(surfaceChangedSinceStart === undefined ? {} : { surfaceChangedSinceStart }),
          ...(surfaceChangedAfterLastAction === undefined ? {} : { surfaceChangedAfterLastAction }),
        });
        const answers = yield* input.runtime.select(request);
        // A stop may land while the model is deciding; check again before the
        // selection is turned into an action.
        if (input.shouldStop !== undefined && (yield* input.shouldStop())) {
          return { status: "cancelled", steps: index } as const;
        }
        step = composeComputerStep({
          goal: input.goal,
          surface,
          answers,
          ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
        });
      }
      if (input.onStep !== undefined) yield* input.onStep(step, index);
      if (step.kind === "done") {
        // An action goal is complete when its activation was applied: that
        // applied result is the evidence the user asked for, and a surface
        // that does not change is not a failure of the click.
        if (expectation.kind === "action") {
          const activation = history.some((line) =>
            /^(?:(?:planned|recovered): )?(?:clicked|pressed)\b/u.test(line),
          );
          return activation
            ? ({ status: "done", steps: index + 1, summary: step.summary, verified: true } as const)
            : ({
                status: "unverified",
                steps: index + 1,
                summary: step.summary,
                reason: "no-effect",
              } as const);
        }
        // Observed change is evidence, not a veto: an action can be a no-op
        // because the goal was already true (pressing 7 while the display
        // already reads 7). A state goal with no action yet is checked too:
        // the surface may already show the result.
        const surfaceChangedSinceStart =
          startDigest === undefined || currentDigest === undefined
            ? undefined
            : currentDigest !== startDigest;
        const surfaceChangedAfterLastAction =
          lastAppliedBaseDigest === undefined || currentDigest === undefined
            ? undefined
            : currentDigest !== lastAppliedBaseDigest;
        const verified =
          input.verify === undefined
            ? applied > 0
            : yield* input.verify({
                goal: input.goal,
                surface,
                history,
                summary: step.summary,
                expectation,
                ...(surfaceChangedSinceStart === undefined ? {} : { surfaceChangedSinceStart }),
                ...(surfaceChangedAfterLastAction === undefined
                  ? {}
                  : { surfaceChangedAfterLastAction }),
              });
        if (verified) {
          return {
            status: "done",
            steps: index + 1,
            summary: step.summary,
            verified: true,
          } as const;
        }
        return {
          status: "unverified",
          steps: index + 1,
          summary: step.summary,
          reason: applied > 0 ? "verification-failed" : "no-effect",
        } as const;
      }
      if (step.kind === "refused") {
        if (yield* recover("refused")) {
          index += 1;
          continue;
        }
        return { status: "refused", reason: step.reason, steps: index + 1 } as const;
      }
      // Last gate before a physical effect: a stop accepted by the node is
      // never followed by another mutation.
      if (input.shouldStop !== undefined && (yield* input.shouldStop())) {
        return { status: "cancelled", steps: index } as const;
      }
      const appliedNow = yield* input.runtime.apply(
        step.action,
        surface.observationRef === undefined
          ? undefined
          : { observationRef: surface.observationRef },
      );
      if (!appliedNow) {
        history.push(`could not apply ${describeComputerAction(step.action)}`);
        index += 1;
        continue;
      }
      // A wait is not evidence of progress, so it never counts toward the
      // effect required before a done can be accepted.
      if (step.action.kind !== "wait") applied += 1;
      history.push(
        `${stepOrigin === null ? "" : `${stepOrigin}: `}${describeComputerAction(step.action)}`,
      );
      lastAppliedBaseDigest = currentDigest;
      index += 1;
      if (index >= maxSteps && (yield* recover("budget-exhausted"))) continue;
    }
    return { status: "budget-exhausted", steps: maxSteps } as const;
  });
