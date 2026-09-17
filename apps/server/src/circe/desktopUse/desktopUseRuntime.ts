import type {
  ComputerAction,
  ComputerElement,
  ComputerSurface,
  ComputerUseRuntime,
} from "@circe/core/computerUse";
import type { DecisionAnswers, DecisionRequest } from "@circe/core/decision";
import * as Effect from "effect/Effect";

/**
 * Desktop runtime for the TypeSafe loop. Grounding comes from an observer
 * (the accessibility tree on Linux), while actions prefer the element's own
 * accessibility action and fall back to a coordinate click at its bounds.
 * The fallback exists because some toolkits expose bounds but no action
 * interface; it never invents a coordinate, it uses the grounded bounds.
 */
export type DesktopScrollDirection = "up" | "down" | "left" | "right";

export interface DesktopActuator<E = never> {
  /**
   * Element activation through the accessibility action interface. Receives
   * the grounded element so the host can re-check its identity; false means
   * the caller may use a coordinate click at the captured bounds.
   */
  readonly activate: (element: ComputerElement) => Effect.Effect<boolean, E>;
  /** Set an editable element's text directly; false when it is not editable. */
  readonly setText: (element: ComputerElement, text: string) => Effect.Effect<boolean, E>;
  /** Coordinate click at a grounded element's bounds. */
  readonly clickAt: (element: ComputerElement) => Effect.Effect<void, E>;
  readonly typeText: (text: string) => Effect.Effect<void, E>;
  readonly pressKey: (key: string) => Effect.Effect<void, E>;
  readonly scroll: (direction: DesktopScrollDirection) => Effect.Effect<void, E>;
  readonly wait?: () => Effect.Effect<void, E>;
}

export interface DesktopUseRuntimeInput<E = never> {
  readonly observe: () => Effect.Effect<ComputerSurface, E>;
  readonly select: (request: DecisionRequest) => Effect.Effect<DecisionAnswers, E>;
  readonly actuator: DesktopActuator<E>;
}

export const makeDesktopUseRuntime = <E = never>(
  input: DesktopUseRuntimeInput<E>,
): ComputerUseRuntime<E> => {
  // The surface the current action was selected against, so a fallback click
  // uses the exact bounds the model saw rather than a fresh, shifted layout.
  let observed: ReadonlyArray<ComputerElement> = [];
  const find = (id: string): ComputerElement | undefined =>
    observed.find((element) => element.id === id);
  return {
    capture: () =>
      input.observe().pipe(
        Effect.tap((surface) =>
          Effect.sync(() => {
            observed = surface.elements;
          }),
        ),
      ),
    select: input.select,
    apply: (action: ComputerAction) =>
      Effect.gen(function* () {
        switch (action.kind) {
          case "click": {
            const element = find(action.elementId);
            if (element === undefined) return;
            if (yield* input.actuator.activate(element)) return;
            yield* input.actuator.clickAt(element);
            return;
          }
          case "type": {
            if (action.elementId !== undefined) {
              const element = find(action.elementId);
              if (element !== undefined) {
                if (yield* input.actuator.setText(element, action.text)) return;
                yield* input.actuator.clickAt(element);
              }
            }
            yield* input.actuator.typeText(action.text);
            return;
          }
          case "press": {
            if (action.elementId !== undefined) {
              const element = find(action.elementId);
              if (element !== undefined) yield* input.actuator.clickAt(element);
            }
            yield* input.actuator.pressKey(action.key);
            return;
          }
          case "scroll":
            yield* input.actuator.scroll(action.direction);
            return;
          case "wait":
            yield* input.actuator.wait?.() ?? Effect.void;
            return;
        }
      }),
  };
};
