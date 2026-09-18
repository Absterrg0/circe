import type { CirceComputerUseInput, CirceComputerUseResult } from "@circe/contracts";
import type {
  ComputerAction,
  ComputerStepRefusal,
  ComputerUseRunResult,
} from "@circe/core/computerUse";
import { runComputerUse } from "@circe/core/computerUse";
import type { DecisionRequest } from "@circe/core/decision";
import {
  computerSurfaceFromSnapshot,
  surfaceActionFromComputerAction,
} from "@circe/core/desktopSurface";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  DesktopSurface,
  type DesktopSurfaceError,
} from "../desktopSurface/Services/DesktopSurface.ts";
import { SurfaceDecisionUnavailableError } from "../computerUse/SurfaceDecisionError.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";

const DECISION_MODEL = "jev-latest";
const WAIT_MS = 300;

type RunError = DesktopSurfaceError | SurfaceDecisionUnavailableError;

const confirmationMessage = (goal: string): string =>
  `I'll control this computer in this session to ${goal}. Confirm to start.`;

const refusalMessage = (reason: ComputerStepRefusal): string => {
  switch (reason) {
    case "confidence-too-low":
      return "I couldn't tell what to do next on this screen.";
    case "unknown-element":
      return "The screen changed before I could act on it.";
    case "missing-parameter":
      return "That step was missing a target or value.";
  }
};

const mapResult = (result: ComputerUseRunResult, goal: string): CirceComputerUseResult => {
  switch (result.status) {
    case "done":
      return { status: "done", message: `Done: ${result.summary}`, steps: result.steps };
    case "budget-exhausted":
      return {
        status: "budget",
        message: `I took ${result.steps} steps but couldn't finish ${goal}.`,
        steps: result.steps,
      };
    case "unverified":
      return {
        status: "refused",
        message: `The model reported ${goal} done, but no action was taken, so I couldn't confirm it.`,
      };
    case "cancelled":
      return { status: "cancelled", message: "Stopped.", steps: result.steps };
    case "refused":
      return { status: "refused", message: refusalMessage(result.reason) };
  }
};

/**
 * The providerless desktop mission: a voice or WebSocket request with no
 * provider session running drives the same observe -> TypeSafe -> act cycle
 * the provider tools expose, in a bounded local loop. It shares one surface
 * implementation with the tools, so a capture-bound action means the same
 * thing either way.
 */
export const make = () =>
  Effect.gen(function* () {
    const surface = yield* DesktopSurface;
    const decision = yield* CirceDecision;
    const cancellation = yield* CirceMissionCancellation;

    const run = Effect.fn("CirceComputerUse.run")(function* (input: CirceComputerUseInput) {
      if (input.confirmed !== true) {
        return { status: "needs-input", message: confirmationMessage(input.goal) } as const;
      }
      const requestId = input.requestMetadata?.requestId;
      if (requestId !== undefined) yield* cancellation.register(requestId);
      // The action must name the capture the decision was made against.
      const captureId = yield* Ref.make<string | null>(null);

      const capture = () =>
        surface.observe({ title: "Desktop" }).pipe(
          Effect.tap((snapshot) => Ref.set(captureId, snapshot.capture.captureId)),
          Effect.map(computerSurfaceFromSnapshot),
        );
      const select = (request: DecisionRequest) =>
        decision
          .decide(request)
          .pipe(
            Effect.flatMap((outcome) =>
              outcome.status === "answered"
                ? Effect.succeed(outcome.answers)
                : Effect.fail(new SurfaceDecisionUnavailableError({ reason: outcome.reason })),
            ),
          );
      const apply = (action: ComputerAction) =>
        Effect.gen(function* () {
          if (action.kind === "wait") {
            yield* Effect.sleep(WAIT_MS);
            return;
          }
          const id = yield* Ref.get(captureId);
          if (id === null) {
            return yield* Effect.fail(
              new SurfaceDecisionUnavailableError({ reason: "no-capture" }),
            );
          }
          const surfaceAction = surfaceActionFromComputerAction(id, action);
          if (surfaceAction === null) return;
          yield* surface.act(surfaceAction);
        });

      return yield* runComputerUse<RunError>({
        model: DECISION_MODEL,
        goal: input.goal,
        ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
        ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
        ...(requestId === undefined
          ? {}
          : { shouldStop: () => cancellation.isCancelled(requestId) }),
        runtime: { capture, select, apply },
      }).pipe(
        Effect.map((result) => mapResult(result, input.goal)),
        Effect.catchTag("SurfaceDecisionUnavailableError", (error) =>
          Effect.succeed({ status: "unavailable" as const, message: error.message }),
        ),
        Effect.catchTag("DesktopSurfaceUnavailableError", (error) =>
          Effect.succeed({ status: "unavailable" as const, message: error.reason }),
        ),
        Effect.catchTag("DesktopSurfaceStaleError", () =>
          Effect.succeed({
            status: "refused" as const,
            message: "The desktop changed before I could act on it.",
          }),
        ),
        Effect.catchTag("DesktopSurfaceBackendError", () =>
          Effect.succeed({
            status: "refused" as const,
            message: "I couldn't drive the desktop for that request.",
          }),
        ),
        Effect.ensuring(requestId === undefined ? Effect.void : cancellation.clear(requestId)),
      );
    });

    return CirceComputerUse.of({ run });
  });

export const CirceComputerUseLive = Layer.effect(CirceComputerUse, make());
