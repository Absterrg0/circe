import type { DecisionAnswers, DecisionRequest } from "../decision.ts";
import { choiceAnswer, noulHolds } from "../decision.ts";
import { NONE_OPTION } from "../toolRegistry.ts";

/**
 * Experiment: extend the System One decision tier to desktop use, where the
 * targets are enumerated (open windows) and the actions are a closed set. No
 * visual grounding, no coordinates, no free text: the model selects a window
 * and an action from supplied options, and code extracts any text to type from
 * an explicit quoted span. This is a spike on a branch; it is not wired into
 * the product.
 */

export interface DesktopWindowOption {
  readonly key: string;
  readonly title: string;
  readonly app: string;
}

export type DesktopDecisionAction = "focus" | "click" | "type" | "scroll" | "key";

export const DESKTOP_DECISION_ACTIONS: ReadonlyArray<DesktopDecisionAction> = [
  "focus",
  "click",
  "type",
  "scroll",
  "key",
];

const ACTION_CRITERIA: Readonly<Record<DesktopDecisionAction, string>> = {
  focus: "Bring a named window to the front.",
  click: "Click inside the selected window.",
  type: "Type text into the selected window.",
  scroll: "Scroll the selected window.",
  key: "Press one named key in the selected window.",
};

const COMMON_KEYS = ["enter", "escape", "tab", "space", "backspace", "up", "down"];
const DIRECTIONS = ["up", "down", "left", "right"];

const choice = (
  instructions: string,
  criteria: Record<string, string | null>,
): DecisionRequest["questions"][string] => ({ type: "choice", instructions, criteria });

const noul = (instructions: string, yes: string, no: string) => ({
  type: "noul" as const,
  instructions,
  criteria: { true: yes, false: no },
});

const windowKey = (window: DesktopWindowOption): string =>
  window.title.trim().length > 0 ? window.title : window.app;

export function buildDesktopDecisionRequest(input: {
  readonly utterance: string;
  readonly windows: ReadonlyArray<DesktopWindowOption>;
}): DecisionRequest {
  const criteria: Record<string, string | null> = {};
  for (const window of input.windows.slice(0, 24)) {
    const key = windowKey(window);
    criteria[key] = window.app === key ? null : `App: ${window.app}`;
  }
  criteria["active"] = "The window that is already in front.";
  criteria[NONE_OPTION] = "No window is implied.";

  const keyCriteria: Record<string, string | null> = {};
  for (const key of COMMON_KEYS) keyCriteria[key] = null;
  keyCriteria[NONE_OPTION] = "No key.";

  const directionCriteria: Record<string, string | null> = {};
  for (const direction of DIRECTIONS) directionCriteria[direction] = null;
  directionCriteria[NONE_OPTION] = "No direction.";

  const actionCriteria: Record<string, string | null> = {};
  for (const action of DESKTOP_DECISION_ACTIONS) actionCriteria[action] = ACTION_CRITERIA[action];

  return {
    state: {
      utterance: input.utterance,
      windows: input.windows.map((window) => ({ title: windowKey(window), app: window.app })),
    },
    model: "jev-latest",
    questions: {
      window: choice("Which open window does the request target?", criteria),
      action: choice("Which desktop action does the request ask for?", actionCriteria),
      typed_text_is_quoted: noul(
        "Is the text to type exactly the quoted span in the utterance?",
        "The quoted span is the text.",
        "No quoted span is the text.",
      ),
      key_name: choice("Which key should be pressed?", keyCriteria),
      direction: choice("Which direction should the window scroll?", directionCriteria),
      needs_clarification: noul(
        "Is the request too ambiguous to act on without asking?",
        "The host must ask before acting.",
        "The request is clear enough to act.",
      ),
    },
  };
}

const QUOTED_SPAN = /"([^"]{1,200})"|'([^']{1,200})'|“([^”]{1,200})”/u;

/** Code-extracted text to type: only an explicit quoted span, never the model's. */
export function extractQuotedText(utterance: string): string | undefined {
  const match = QUOTED_SPAN.exec(utterance);
  if (match === null) return undefined;
  return match[1] ?? match[2] ?? match[3];
}

export type DesktopSelection =
  | {
      readonly status: "selected";
      readonly window: string;
      readonly action: DesktopDecisionAction;
      readonly key?: string;
      readonly direction?: string;
      readonly text?: string;
    }
  | { readonly status: "clarify"; readonly prompt: string };

const WINDOW_FLOOR = 0.6;
const ACTION_FLOOR = 0.7;

/**
 * Compose a desktop selection. Mutating actions never dispatch below a high
 * confidence, and a `type` action refuses unless code found a quoted span.
 */
export function composeDesktopSelection(input: {
  readonly utterance: string;
  readonly answers: DecisionAnswers;
}): DesktopSelection {
  const needsClarification = noulHolds(input.answers, "needs_clarification", 0.5) ?? false;
  if (needsClarification) {
    return { status: "clarify", prompt: "Which window and what should I do in it?" };
  }
  const window = choiceAnswer(input.answers, "window");
  if (window === undefined || window.confidence < WINDOW_FLOOR || window.choice === NONE_OPTION) {
    return { status: "clarify", prompt: "Which window do you mean?" };
  }
  const action = choiceAnswer(input.answers, "action");
  if (action === undefined || action.confidence < ACTION_FLOOR) {
    return { status: "clarify", prompt: "What should I do in that window?" };
  }
  const selected = action.choice as DesktopDecisionAction;
  if (!DESKTOP_DECISION_ACTIONS.includes(selected)) {
    return { status: "clarify", prompt: "I couldn't tell what to do in that window." };
  }
  if (selected === "type") {
    const quoted = noulHolds(input.answers, "typed_text_is_quoted", 0.5) ?? false;
    const text = extractQuotedText(input.utterance);
    if (!quoted || text === undefined) {
      return { status: "clarify", prompt: "Say the exact text to type in quotes." };
    }
    return { status: "selected", window: window.choice, action: selected, text };
  }
  if (selected === "key") {
    const key = choiceAnswer(input.answers, "key_name");
    if (key === undefined || key.confidence < ACTION_FLOOR || key.choice === NONE_OPTION) {
      return { status: "clarify", prompt: "Which key should I press?" };
    }
    return { status: "selected", window: window.choice, action: selected, key: key.choice };
  }
  if (selected === "scroll") {
    const direction = choiceAnswer(input.answers, "direction");
    if (
      direction === undefined ||
      direction.confidence < ACTION_FLOOR ||
      direction.choice === NONE_OPTION
    ) {
      return { status: "clarify", prompt: "Which way should I scroll?" };
    }
    return {
      status: "selected",
      window: window.choice,
      action: selected,
      direction: direction.choice,
    };
  }
  return { status: "selected", window: window.choice, action: selected };
}
