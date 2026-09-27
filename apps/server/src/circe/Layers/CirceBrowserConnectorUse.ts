import type { CirceBrowserUseInput } from "@circe/contracts";
import {
  buildComputerVerificationRequest,
  computerGoalVerified,
  runComputerUse,
  type ComputerUseVerificationInput,
} from "@circe/core/computerUse";
import type { DecisionRequest } from "@circe/core/decision";
import { circeWebsiteUrl } from "@circe/core/website";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { extractWebsiteCandidates } from "../decisionTier.ts";
import { SurfaceDecisionUnavailableError } from "../computerUse/SurfaceDecisionError.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import {
  CirceBrowserConnector,
  type CirceBrowserConnectorError,
} from "../Services/CirceBrowserConnector.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";
import { CirceRecoveryPlanner } from "../Services/CirceRecoveryPlanner.ts";
import { CirceBrowserConnectorUse } from "../Services/CirceBrowserConnectorUse.ts";
import { confirmationMessage, mapCirceBrowserMissionResult } from "./CirceBrowserUse.ts";
import { makeConnectorUseRuntime } from "../browserConnector/connectorUseRuntime.ts";

const DECISION_MODEL = "jev-latest";

const noConnectorMessage =
  "The browser connector isn't connected. Install the Circe Chrome extension and keep Chrome open, then ask again.";

const noTabMessage = "No browser tab is available to control. Open a tab in Chrome and ask again.";

/**
 * Real-browser missions over the Chrome extension connector. The user's own
 * signed-in profile is the target, one visible tab is attached, and every
 * step is grounded in the extension's own element handles.
 */
export const make = Effect.gen(function* () {
  const connector = yield* CirceBrowserConnector;
  const decisionOpt = yield* Effect.serviceOption(CirceDecision);
  const decision = Option.getOrElse(decisionOpt, () => ({
    decide: (_request: DecisionRequest) =>
      Effect.succeed({ status: "decline", reason: "decision-disabled" } as const),
  }));
  const cancellation = yield* CirceMissionCancellation;
  const recoveryOpt = yield* Effect.serviceOption(CirceRecoveryPlanner);
  const recovery = Option.getOrUndefined(recoveryOpt);

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

  const verify = (input: ComputerUseVerificationInput): Effect.Effect<boolean> =>
    decision
      .decide(
        // The same evidence the desktop check gets: whether anything on the
        // page changed, so a claim of done needs something to show.
        buildComputerVerificationRequest({ model: DECISION_MODEL, ...input }),
      )
      .pipe(
        Effect.map(
          (outcome) =>
            outcome.status === "answered" && computerGoalVerified(outcome.answers) === true,
        ),
        Effect.orElseSucceed(() => false),
      );

  const run = Effect.fn("CirceBrowserConnectorUse.run")(function* (input: CirceBrowserUseInput) {
    const requestId = input.requestMetadata?.requestId;
    if (requestId !== undefined) yield* cancellation.register(requestId);
    const stopped = () =>
      requestId === undefined ? Effect.succeed(false) : cancellation.isCancelled(requestId);
    // Confirmation, attachment and the opening navigation are one mission:
    // the same registration and the same cleanup cover the whole of it, and
    // a stop accepted before a mutation cancels instead of acting.
    const outcome = Effect.gen(function* () {
      if (input.confirmed !== true) {
        return { status: "needs-input", message: confirmationMessage(input.goal) } as const;
      }
      // An accepted target pins the profile and tab for the whole mission: a
      // disconnected profile is an error, never a reason to drive whichever
      // connection happens to remain.
      const pinnedProfile = input.target?.profile;
      const pinnedTabId = input.target?.tabId;
      const status = yield* connector.status(pinnedProfile);
      if (
        !status.connected ||
        (pinnedProfile !== undefined && status.profileLabel !== pinnedProfile)
      ) {
        return {
          status: "unavailable",
          message:
            pinnedProfile === undefined
              ? noConnectorMessage
              : `The browser profile "${pinnedProfile}" is not connected. Reconnect it or choose another profile.`,
        } as const;
      }
      if (
        status.attachedTabId === undefined ||
        (pinnedTabId !== undefined && status.attachedTabId !== pinnedTabId)
      ) {
        const tabs = yield* connector
          .listTabs(pinnedProfile)
          .pipe(Effect.catch(() => Effect.succeed([] as const)));
        const target =
          pinnedTabId === undefined
            ? (tabs.find((tab) => tab.active) ?? tabs[0])
            : tabs.find((tab) => tab.tabId === pinnedTabId);
        if (target === undefined) {
          return {
            status: "unavailable",
            message:
              pinnedTabId === undefined ? noTabMessage : "That browser tab is no longer open.",
          } as const;
        }
        const attached = yield* connector
          .attach({
            tabId: target.tabId,
            ...(pinnedProfile === undefined ? {} : { profileLabel: pinnedProfile }),
          })
          .pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
        if (!attached) {
          return { status: "unavailable", message: noTabMessage } as const;
        }
      }

      // A goal that names a site navigates the attached tab before the first
      // step, so the loop works the page the user asked for.
      const startUrl = (() => {
        for (const candidate of extractWebsiteCandidates(input.goal)) {
          const url = circeWebsiteUrl(candidate, input.goal);
          if (url !== null) return url;
        }
        return null;
      })();
      if (startUrl !== null) {
        if (yield* stopped()) {
          return { status: "cancelled", message: "Stopped.", steps: 0 } as const;
        }
        yield* connector
          .apply({ operation: "navigate", url: startUrl }, pinnedProfile)
          .pipe(Effect.catch(() => Effect.succeed(false)));
      }

      if (yield* stopped()) {
        return { status: "cancelled", message: "Stopped.", steps: 0 } as const;
      }
      type RunError = SurfaceDecisionUnavailableError | CirceBrowserConnectorError;
      return yield* runComputerUse<RunError>({
        model: DECISION_MODEL,
        goal: input.goal,
        ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
        ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
        ...(requestId === undefined
          ? {}
          : { shouldStop: () => cancellation.isCancelled(requestId) }),
        verify,
        ...(recovery === undefined ? {} : { replan: recovery.plan, plan: recovery.planGoal }),
        runtime: makeConnectorUseRuntime({
          connector,
          select,
          ...(pinnedProfile === undefined ? {} : { profileLabel: pinnedProfile }),
        }),
      }).pipe(
        Effect.map((result) => mapCirceBrowserMissionResult(result, input.goal)),
        Effect.catchTag("SurfaceDecisionUnavailableError", (error) =>
          Effect.succeed({ status: "unavailable" as const, message: error.message }),
        ),
        Effect.catch(() =>
          Effect.succeed({
            status: "refused" as const,
            message: "I couldn't drive the browser for that request.",
          }),
        ),
      );
    });
    return yield* outcome.pipe(
      Effect.ensuring(requestId === undefined ? Effect.void : cancellation.clear(requestId)),
    );
  });

  return CirceBrowserConnectorUse.of({ run });
});

export const CirceBrowserConnectorUseLive = Layer.effect(CirceBrowserConnectorUse, make);
