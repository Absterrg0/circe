import type {
  CirceBrowserUseInput,
  CirceBrowserUseResult,
  PreviewAutomationError,
} from "@circe/contracts";
import { ThreadId } from "@circe/contracts";
import type { ComputerUseRunResult, ComputerStepRefusal } from "@circe/core/computerUse";
import { runBrowserGoal } from "@circe/core/browserUseRuntime";
import type { DecisionRequest } from "@circe/core/decision";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { PreviewAutomationBroker } from "../../mcp/PreviewAutomationBroker.ts";
import { circeAutomationScope } from "../computerUse/CirceAutomationScope.ts";
import { makePreviewAutomationInvoker } from "../computerUse/PreviewAutomationInvoker.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceBrowserUse } from "../Services/CirceBrowserUse.ts";

/**
 * Production browser use. The scope is stable for one control session so the
 * broker pins a single desktop host, and the decision tier is the only
 * non-deterministic step: it selects among grounded elements, and the loop
 * derives the concrete selector-targeted operation.
 */
const DECISION_MODEL = "jev-latest";
const CONTROL_THREAD = ThreadId.make("circe-browser-use");
const WAIT_MS = 400;

const confirmationMessage = (goal: string): string =>
  `I'll control the browser in this session to ${goal}. Confirm to start.`;

const refusalMessage = (reason: ComputerStepRefusal): string => {
  switch (reason) {
    case "confidence-too-low":
      return "I couldn't tell what to do next on that page.";
    case "unknown-element":
      return "The page changed before I could act on it.";
    case "missing-parameter":
      return "That step was missing a target or value.";
  }
};

const mapResult = (result: ComputerUseRunResult, goal: string): CirceBrowserUseResult => {
  switch (result.status) {
    case "done":
      return { status: "done", message: `Done: ${result.summary}`, steps: result.steps };
    case "budget-exhausted":
      return {
        status: "budget",
        message: `I took ${result.steps} steps but couldn't finish ${goal}.`,
        steps: result.steps,
      };
    case "clarification":
      return { status: "needs-input", message: result.prompt };
    case "refused":
      return { status: "refused", message: refusalMessage(result.reason) };
  }
};

export const make = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker;
  const decision = yield* CirceDecision;
  const serverEnvironment = yield* ServerEnvironment;

  const run = Effect.fn("CirceBrowserUse.run")(function* (input: CirceBrowserUseInput) {
    if (input.confirmed !== true) {
      return { status: "needs-input", message: confirmationMessage(input.goal) } as const;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const controlSessionId =
      input.requestMetadata?.origin?.originInteractionId ??
      input.requestMetadata?.requestId ??
      "circe-browser";
    const scope = yield* circeAutomationScope({
      environmentId,
      threadId: CONTROL_THREAD,
      controlSessionId,
    });
    const invoker = makePreviewAutomationInvoker({
      invoke: broker.invoke,
      scope,
      waitMs: WAIT_MS,
    });
    const select = (request: DecisionRequest) =>
      decision
        .decide(request)
        .pipe(Effect.map((outcome) => (outcome.status === "answered" ? outcome.answers : {})));
    return yield* runBrowserGoal<PreviewAutomationError>({
      model: DECISION_MODEL,
      goal: input.goal,
      ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
      ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
      invoker,
      select,
    }).pipe(
      Effect.map((result) => mapResult(result, input.goal)),
      Effect.catchTag("PreviewAutomationNoAvailableHostError", () =>
        Effect.succeed({
          status: "unavailable" as const,
          message: "No browser is connected to this node yet.",
        }),
      ),
      Effect.catchTag("PreviewAutomationUnavailableError", () =>
        Effect.succeed({
          status: "unavailable" as const,
          message: "Browser control is unavailable on this node.",
        }),
      ),
      Effect.catchTag("PreviewAutomationTimeoutError", () =>
        Effect.succeed({
          status: "refused" as const,
          message: "The browser didn't respond in time.",
        }),
      ),
      Effect.catch(() =>
        Effect.succeed({
          status: "refused" as const,
          message: "I couldn't drive the browser for that request.",
        }),
      ),
    );
  });

  return CirceBrowserUse.of({ run });
});

export const CirceBrowserUseLive = Layer.effect(CirceBrowserUse, make);
