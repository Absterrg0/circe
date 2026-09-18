import type {
  PreviewAutomationClickInput,
  PreviewAutomationElement,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationTypeInput,
} from "@circe/contracts";

import type {
  ComputerAction,
  ComputerElement,
  ComputerPressKey,
  ComputerSurface,
} from "./computerUse.ts";

/**
 * Browser surface adapter. The broker already returns grounded
 * `PreviewAutomationElement` records with role, name, selector, and bounds;
 * this maps them into the surface shape the deterministic step layer selects
 * over, and maps a derived `ComputerAction` back into the exact automation
 * operation input. The selector is the element id, so a click or type never
 * carries a model-invented coordinate.
 */

const SCROLL_DELTA_PX = 600;

/**
 * The browser host resolves keys by exact name from its `NAMED_KEYS` table
 * ("Enter", "ArrowUp", "PageUp"). The step layer uses lowercase ids, so the
 * boundary must translate; passing "enter" through would emit a raw key event
 * that never presses Enter.
 */
const BROWSER_PRESS_KEY: Readonly<Record<ComputerPressKey, string>> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  backspace: "Backspace",
  pageup: "PageUp",
  pagedown: "PageDown",
};

export function computerElementFromPreview(element: PreviewAutomationElement): ComputerElement {
  return {
    id: element.selector,
    role: element.role,
    name: element.name,
    bounds: { x: element.x, y: element.y, width: element.width, height: element.height },
  };
}

export interface BrowserSurfaceOptions {
  readonly maxElements?: number;
}

/** Grounded browser surface from one automation snapshot. */
export function browserSurfaceFromSnapshot(
  snapshot: Pick<
    PreviewAutomationSnapshot,
    "title" | "url" | "visibleText" | "interactiveElements"
  >,
  options: BrowserSurfaceOptions = {},
): ComputerSurface {
  const maxElements = options.maxElements ?? 60;
  const seen = new Set<string>();
  const elements: Array<ComputerElement> = [];
  for (const element of snapshot.interactiveElements) {
    if (element.selector.length === 0 || seen.has(element.selector)) continue;
    seen.add(element.selector);
    elements.push(computerElementFromPreview(element));
    if (elements.length >= maxElements) break;
  }
  return {
    kind: "browser",
    title: snapshot.title,
    url: snapshot.url,
    visibleText: snapshot.visibleText,
    elements,
  };
}

/**
 * The automation operation one derived action maps to, or null when the
 * action has no browser operation (wait and done are handled by the runner).
 */
export type BrowserAutomationOperation =
  | { readonly operation: "click"; readonly input: PreviewAutomationClickInput }
  | { readonly operation: "type"; readonly input: PreviewAutomationTypeInput }
  | { readonly operation: "press"; readonly input: PreviewAutomationPressInput }
  | { readonly operation: "scroll"; readonly input: PreviewAutomationScrollInput };

export function browserOperationForAction(
  action: ComputerAction,
): BrowserAutomationOperation | null {
  switch (action.kind) {
    case "click":
      return { operation: "click", input: { locator: action.elementId } };
    case "type":
      return {
        operation: "type",
        input:
          action.elementId === undefined
            ? { text: action.text }
            : { text: action.text, locator: action.elementId },
      };
    case "press":
      // The browser press operation targets only the focused element, so a
      // selected element is a no-op here; focus it with a click first.
      return { operation: "press", input: { key: BROWSER_PRESS_KEY[action.key] } };
    case "scroll": {
      const input: PreviewAutomationScrollInput =
        action.direction === "up" || action.direction === "down"
          ? { deltaY: action.direction === "down" ? SCROLL_DELTA_PX : -SCROLL_DELTA_PX }
          : { deltaX: action.direction === "right" ? SCROLL_DELTA_PX : -SCROLL_DELTA_PX };
      return { operation: "scroll", input };
    }
    case "wait":
      return null;
  }
}
