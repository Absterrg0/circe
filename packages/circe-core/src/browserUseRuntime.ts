import type { PreviewAutomationSnapshot } from "@circe/contracts";
import * as Effect from "effect/Effect";

import {
  browserOperationForAction,
  browserSurfaceFromSnapshot,
  type BrowserAutomationOperation,
} from "./browserUse.ts";
import {
  runComputerUse,
  type ComputerUseRunResult,
  type ComputerUseRuntime,
} from "./computerUse.ts";
import type { DecisionAnswers, DecisionRequest } from "./decision.ts";

/**
 * The browser runtime the TypeSafe loop drives. Perception (a fresh grounded
 * snapshot) and automation (selector-targeted operations) are injected so the
 * server backs them with the previewAutomation broker while tests drive them
 * with a fake. Nothing here lets the model see pixels or name a coordinate:
 * the observer produces the text catalog and the operation carries only a
 * grounded selector.
 */
/** Only the grounded fields the surface needs; a full snapshot is assignable. */
export type BrowserAutomationSnapshot = Pick<
  PreviewAutomationSnapshot,
  "title" | "url" | "visibleText" | "interactiveElements"
>;

export interface BrowserAutomationInvoker<E = never> {
  /** One grounded snapshot of the current tab. */
  readonly snapshot: () => Effect.Effect<BrowserAutomationSnapshot, E>;
  /** Run one grounded operation on the current tab. */
  readonly apply: (operation: BrowserAutomationOperation) => Effect.Effect<void, E>;
  /** Settle delay for a wait action; defaults to a no-op. */
  readonly wait?: () => Effect.Effect<void, E>;
}

export interface BrowserUseRuntimeInput<E = never> {
  readonly invoker: BrowserAutomationInvoker<E>;
  readonly select: (request: DecisionRequest) => Effect.Effect<DecisionAnswers, E>;
  readonly maxElements?: number;
}

export const makeBrowserUseRuntime = <E = never>(
  input: BrowserUseRuntimeInput<E>,
): ComputerUseRuntime<E> => ({
  capture: () =>
    input.invoker.snapshot().pipe(
      Effect.map((snapshot) =>
        browserSurfaceFromSnapshot(snapshot, {
          ...(input.maxElements === undefined ? {} : { maxElements: input.maxElements }),
        }),
      ),
    ),
  select: input.select,
  apply: (action) => {
    const operation = browserOperationForAction(action);
    if (operation === null) return input.invoker.wait?.() ?? Effect.void;
    return input.invoker.apply(operation);
  },
});

export interface RunBrowserGoalInput<E = never> extends BrowserUseRuntimeInput<E> {
  readonly model: string;
  readonly goal: string;
  readonly typeText?: string;
  readonly maxSteps?: number;
  readonly onStep?: (
    step: import("./computerUse.ts").ComputerStep,
    index: number,
  ) => Effect.Effect<void, E>;
}

/** Plan-free browser loop: the selector chooses each grounded action. */
export const runBrowserGoal = <E = never>(
  input: RunBrowserGoalInput<E>,
): Effect.Effect<ComputerUseRunResult, E> =>
  runComputerUse({
    model: input.model,
    goal: input.goal,
    runtime: makeBrowserUseRuntime(input),
    ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.onStep === undefined ? {} : { onStep: input.onStep }),
  });
