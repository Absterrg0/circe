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
  /**
   * Click the grounded element through its executable address. False means
   * nothing was dispatched (a consumed or refused capture, a stale token) and
   * the surface must be observed again; it is never a cue to retry.
   */
  readonly click: (element: ComputerElement) => Effect.Effect<boolean, E>;
  /** Type into the grounded native element; false means nothing was dispatched. */
  readonly typeInto: (element: ComputerElement, text: string) => Effect.Effect<boolean, E>;
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
  /** A richer observation of the same window, or undefined when there is none. */
  readonly escalate?: () => Effect.Effect<ComputerSurface | undefined, E>;
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
  const adopt = (surface: ComputerSurface): ComputerSurface => {
    observed = surface.elements;
    generation += 1;
    observedRef = `observation-${generation}`;
    return { ...surface, observationRef: observedRef };
  };
  const escalate = input.escalate;
  return {
    capture: () => input.observe().pipe(Effect.map(adopt)),
    ...(escalate === undefined
      ? {}
      : {
          escalate: () =>
            escalate().pipe(
              Effect.map((surface) => (surface === undefined ? undefined : adopt(surface))),
            ),
        }),
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
            return yield* input.actuator.click(element);
          }
          case "type": {
            const element = find(action.elementId);
            if (element === undefined) return false;
            return yield* input.actuator.typeInto(element, action.text);
          }
          case "press": {
            const element = find(action.elementId);
            if (element === undefined || element.source === "visual") return false;
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
