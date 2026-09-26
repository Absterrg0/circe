import type {
  ComputerAction,
  ComputerElement,
  ComputerSurface,
  ComputerUseRuntime,
} from "@circe/core/computerUse";
import type { DecisionAnswers, DecisionRequest } from "@circe/core/decision";
import * as Effect from "effect/Effect";

/**
 * Desktop runtime for the TypeSafe loop. Grounding comes from the computer
 * host's window observation; every action is one exact dispatch.
 *
 * There is deliberately no retry or fallback: a driver action either reports a
 * verified effect or fails with a typed error. An uncertain effect must reach
 * the mission as uncertainty, never become a boolean that selects a second,
 * weaker attempt. The driver already chooses its own delivery route (semantic
 * action or pixel input) inside one call.
 */

export type DesktopScrollDirection = "up" | "down" | "left" | "right";

export interface DesktopActuator<E = never> {
  /** Click the grounded element by its observation token. */
  readonly click: (element: ComputerElement) => Effect.Effect<void, E>;
  /** Type into the grounded element by its observation token. */
  readonly typeInto: (element: ComputerElement, text: string) => Effect.Effect<void, E>;
  /** Press one key in the mission's target window. */
  readonly pressKey: (key: string) => Effect.Effect<void, E>;
  /** Type into the mission's focused surface without re-targeting. */
  readonly typeText: (text: string) => Effect.Effect<void, E>;
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
  // The surface the current action was selected against, so an action carrying
  // a stale reference is refused rather than applied to a shifted layout.
  let observed: ReadonlyArray<ComputerElement> = [];
  let observedRef: string | undefined;
  let generation = 0;
  const find = (id: string): ComputerElement | undefined =>
    observed.find((element) => element.id === id);
  return {
    capture: () =>
      input.observe().pipe(
        Effect.map((surface) => {
          observed = surface.elements;
          generation += 1;
          observedRef = `observation-${generation}`;
          return { ...surface, observationRef: observedRef };
        }),
      ),
    select: input.select,
    apply: (action: ComputerAction, context) =>
      Effect.gen(function* () {
        if (context?.observationRef !== undefined && context.observationRef !== observedRef) {
          return false;
        }
        switch (action.kind) {
          case "click": {
            const element = find(action.elementId);
            if (element === undefined) return false;
            yield* input.actuator.click(element);
            return true;
          }
          case "type": {
            const element = find(action.elementId);
            if (element === undefined) return false;
            yield* input.actuator.typeInto(element, action.text);
            return true;
          }
          case "press": {
            const element = find(action.elementId);
            if (element === undefined) return false;
            // Keyboard input goes to the mission's exact target window, not to
            // whatever happens to hold ambient focus after a click.
            yield* input.actuator.pressKey(action.key);
            return true;
          }
          case "scroll":
            yield* input.actuator.scroll(action.direction);
            return true;
          case "wait":
            yield* input.actuator.wait?.() ?? Effect.void;
            return true;
        }
      }),
  };
};
