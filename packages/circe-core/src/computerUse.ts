import * as Effect from "effect/Effect";

import { choiceAnswer, type DecisionAnswers, type DecisionRequest } from "./decision.ts";
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
  readonly elements: ReadonlyArray<ComputerElement>;
}

export const COMPUTER_ACTION_KINDS = ["click", "type", "press", "scroll", "wait", "done"] as const;
export type ComputerActionKind = (typeof COMPUTER_ACTION_KINDS)[number];

/**
 * Typing is the one value a closed step cannot pick from the surface, and a
 * voice mission has no provider plan to supply it. The text must come from the
 * user's own words, so the request offers every bounded contiguous span of the
 * goal as a closed choice and composition slices the chosen span verbatim. The
 * model never emits free text; it selects among spans code already built.
 */
export const COMPUTER_TYPE_TEXT_MAX_RUN_TOKENS = 5;
export const COMPUTER_TYPE_TEXT_MAX_CANDIDATES = 48;

export function buildTypeTextCandidates(goal: string): ReadonlyArray<string> {
  const tokens = goal.split(/\s+/).filter((token) => token.length > 0);
  const seen = new Set<string>();
  const candidates: Array<string> = [];
  // Longer runs first: a search phrase is a phrase, and the cap must never
  // crowd out the multi-word spans in favor of single tokens.
  for (let length = COMPUTER_TYPE_TEXT_MAX_RUN_TOKENS; length >= 1; length -= 1) {
    for (let start = 0; start + length <= tokens.length; start += 1) {
      const run = tokens.slice(start, start + length).join(" ");
      if (run.length < 2 || !/[\p{Letter}\p{Number}]/u.test(run)) continue;
      if (seen.has(run)) continue;
      seen.add(run);
      candidates.push(run);
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
  | { readonly kind: "type"; readonly elementId?: string; readonly text: string }
  | { readonly kind: "press"; readonly elementId?: string; readonly key: ComputerPressKey }
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
  type: "Enter the planned text into the chosen element, or the focused field when none is chosen.",
  press: "Press one named key, optionally after focusing the chosen element.",
  scroll: "Scroll the surface in one direction.",
  wait: "Let the surface settle before looking again.",
  done: "The goal is already satisfied; stop.",
};

const elementLabel = (element: ComputerElement): string =>
  `${element.role ?? "element"}: ${element.name}`.slice(0, 200);

export interface BuildComputerStepRequestInput {
  readonly model: string;
  readonly goal: string;
  readonly surface: ComputerSurface;
  /** Provider-supplied text for a type action; enables the action when present. */
  readonly typeText?: string;
  readonly history?: ReadonlyArray<string>;
  readonly maxElements?: number;
}

function boundedSurface(surface: ComputerSurface, maxElements: number) {
  return {
    kind: surface.kind,
    title: surface.title.slice(0, 240),
    ...(surface.url === undefined ? {} : { url: surface.url.slice(0, 2048) }),
    ...(surface.visibleText === undefined
      ? {}
      : { visibleText: surface.visibleText.slice(0, COMPUTER_STEP_MAX_VISIBLE_TEXT) }),
    elementCount: surface.elements.length,
    elements: surface.elements.slice(0, maxElements).map((element) => ({
      id: element.id,
      role: element.role,
      name: element.name.slice(0, 200),
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
        "Which single next action moves the goal forward? Choose done only when the goal is already satisfied.",
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
    const element = selectedElement(input.surface, input.answers);
    if (element.status === "unknown") return { kind: "refused", reason: "unknown-element" };
    return {
      kind: "action",
      action:
        element.status === "element"
          ? { kind: "type", elementId: element.id, text }
          : { kind: "type", text },
    };
  }

  if (action === "press") {
    const key = readChoice(input.answers, PRESS_KEY_QUESTION);
    if (key === undefined || !isPressKey(key))
      return { kind: "refused", reason: "missing-parameter" };
    const element = selectedElement(input.surface, input.answers);
    if (element.status === "unknown") return { kind: "refused", reason: "unknown-element" };
    return {
      kind: "action",
      action:
        element.status === "element"
          ? { kind: "press", elementId: element.id, key }
          : { kind: "press", key },
    };
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

/** One-line history entry for the next step's prompt. */
export function describeComputerAction(action: ComputerAction): string {
  switch (action.kind) {
    case "click":
      return `clicked ${action.elementId}`;
    case "type":
      return action.elementId === undefined
        ? `typed "${action.text.slice(0, 60)}"`
        : `typed "${action.text.slice(0, 60)}" into ${action.elementId}`;
    case "press":
      return action.elementId === undefined
        ? `pressed ${action.key}`
        : `pressed ${action.key} on ${action.elementId}`;
    case "scroll":
      return `scrolled ${action.direction}`;
    case "wait":
      return "waited for the surface to settle";
  }
}

export interface ComputerUseRuntime<E = never> {
  readonly capture: () => Effect.Effect<ComputerSurface, E>;
  readonly select: (request: DecisionRequest) => Effect.Effect<DecisionAnswers, E>;
  readonly apply: (action: ComputerAction) => Effect.Effect<void, E>;
}

export interface ComputerUseRunInput<E = never> {
  readonly model: string;
  readonly goal: string;
  readonly runtime: ComputerUseRuntime<E>;
  readonly typeText?: string;
  readonly maxSteps?: number;
  readonly maxElements?: number;
  readonly onStep?: (step: ComputerStep, index: number) => Effect.Effect<void, E>;
  /** Checked between steps so a user can stop a running mission. */
  readonly shouldStop?: () => Effect.Effect<boolean, E>;
}

export const COMPUTER_USE_DEFAULT_MAX_STEPS = 24;

export type ComputerUseRunResult =
  | { readonly status: "done"; readonly steps: number; readonly summary: string }
  /**
   * The selector reported done without applying a single action. The claim is
   * reported, not accepted: nothing observable backs it, so the caller must not
   * present it as a completed task.
   */
  | { readonly status: "unverified"; readonly steps: number; readonly summary: string }
  | { readonly status: "budget-exhausted"; readonly steps: number }
  | { readonly status: "cancelled"; readonly steps: number }
  | { readonly status: "refused"; readonly reason: ComputerStepRefusal; readonly steps: number };

/**
 * Capture, select, apply, repeat. Every step starts from a fresh surface so a
 * selection always binds to the state the model just saw, and the same
 * surface shape serves browser and desktop once both provide grounding.
 */
export const runComputerUse = <E = never>(
  input: ComputerUseRunInput<E>,
): Effect.Effect<ComputerUseRunResult, E> =>
  Effect.gen(function* () {
    const maxSteps = input.maxSteps ?? COMPUTER_USE_DEFAULT_MAX_STEPS;
    const maxElements = input.maxElements ?? COMPUTER_STEP_DEFAULT_MAX_ELEMENTS;
    const history: Array<string> = [];
    let applied = 0;
    for (let index = 0; index < maxSteps; index += 1) {
      // A stop lands between steps, so it never interrupts an action mid-flight.
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
      const request = buildComputerStepRequest({
        model: input.model,
        goal: input.goal,
        surface,
        maxElements,
        ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
        history,
      });
      const answers = yield* input.runtime.select(request);
      const step = composeComputerStep({
        goal: input.goal,
        surface,
        answers,
        ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
      });
      if (input.onStep !== undefined) yield* input.onStep(step, index);
      if (step.kind === "done") {
        // Evidence-based completion: a done is only confirmed once the loop has
        // applied at least one action. A done before any action is surfaced as
        // unverified so a false claim never reads as success.
        return applied === 0
          ? ({ status: "unverified", steps: index + 1, summary: step.summary } as const)
          : ({ status: "done", steps: index + 1, summary: step.summary } as const);
      }
      if (step.kind === "refused") {
        return { status: "refused", reason: step.reason, steps: index + 1 } as const;
      }
      yield* input.runtime.apply(step.action);
      applied += 1;
      history.push(describeComputerAction(step.action));
    }
    return { status: "budget-exhausted", steps: maxSteps } as const;
  });
