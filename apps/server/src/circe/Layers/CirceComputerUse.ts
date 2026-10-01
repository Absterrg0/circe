import type {
  CirceComputerUseInput,
  CirceComputerUseResult,
  ComputerHostToolResult,
} from "@circe/contracts";
import type {
  ComputerElement,
  ComputerStepRefusal,
  ComputerSurface,
  ComputerUseRunResult,
} from "@circe/core/computerUse";
import {
  buildComputerVerificationRequest,
  computerGoalVerified,
  inferComputerExpectation,
  runComputerUse,
} from "@circe/core/computerUse";
import type { DecisionRequest } from "@circe/core/decision";
import { rankSurfaceForGoal, resolveDesktopApp } from "@circe/core/desktopApp";
import { singleClickTarget } from "@circe/core/singleClickGoal";
import { circeWebsiteUrl } from "@circe/core/website";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { cuaPlatform } from "../../computer/cuaObservation.ts";
import {
  readApps,
  readLaunchPid,
  readWindows,
  type CuaApp,
  type CuaWindow,
} from "../../computer/driverSchemas.ts";
import {
  CAPTURE_REFUSAL_CODES,
  clickArguments,
  GroundingError,
  observeGrounded,
  type GroundedObservation,
} from "../../computer/grounding.ts";
import {
  ComputerMissionError,
  ComputerService,
  ComputerUnavailableError,
  type ComputerMission,
} from "../../computer/ComputerService.ts";
import {
  DesktopElementChangedError,
  SurfaceDecisionUnavailableError,
} from "../computerUse/SurfaceDecisionError.ts";
import { extractWebsiteCandidates } from "../decisionTier.ts";
import {
  makeDesktopUseRuntime,
  type DesktopScrollDirection,
} from "../computerUse/desktopRuntime.ts";
import { makeCoreDesktopHost } from "../computerUse/coreDesktopHost.ts";
import { loadCirceCore, type CirceCore, type DesktopOutcome, type Jev } from "../host/core.ts";
import { makeJevRoute } from "../host/jevRoute.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceDecisionLive } from "./CirceDecision.ts";
import { CirceComputerUse, type CirceComputerGoal } from "../Services/CirceComputerUse.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";
import { CirceRecoveryPlanner } from "../Services/CirceRecoveryPlanner.ts";

const DECISION_MODEL = "jev-latest";
const WAIT_MS = 300;
const WINDOW_READY_TIMEOUT_MS = 15_000;
const WINDOW_POLL_MS = 500;
const SCROLL_LINES = 5;
const BROWSER_APP_PATTERN = /(chrome|chromium|brave|edge|helium|firefox|safari|vivaldi|opera|arc)/i;

/**
 * Desktop missions run on the Cua-backed computer host. The server owns the
 * mission, its decisions, and the audit trail; the desktop host owns the OS
 * session and input. Every observation and action below is an ordinary
 * computer-service call, so a mission is stoppable and auditable exactly like
 * a provider-driven one.
 *
 * Clean dispatches are followed by a fresh observation and goal verification.
 * Unknown delivery stops the mission; no action is repeated through a weaker
 * target. Application targets are bound to the driver's process identity.
 */

interface MissionTarget {
  readonly pid: number;
  readonly windowId: number;
  readonly appName: string;
  readonly title: string;
}

const confirmationMessage = (goal: string): string =>
  `I'll control this computer in this session to ${goal}. Confirm to start.`;

const refusalMessage = (reason: ComputerStepRefusal): string => {
  switch (reason) {
    case "confidence-too-low":
      return "I couldn't tell what to do next on this screen.";
    case "unknown-element":
      return "The screen changed before I could act on it.";
    case "missing-parameter":
      return "I couldn't tell which thing to act on for that step.";
    case "unsupported-target":
      return "That step needs a control I can type into, and this window only shows it as pixels.";
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
        message:
          result.reason === "no-effect"
            ? `The model reported ${goal} done, but no action was taken, so I couldn't confirm it.`
            : `I acted, but the screen didn't show ${goal} finished, so I won't claim it.`,
      };
    case "cancelled":
      return { status: "cancelled", message: "Stopped.", steps: result.steps };
    case "refused":
      return { status: "refused", message: refusalMessage(result.reason) };
  }
};

/** What circe-core's outcome means for the requester. Only a goal the screen shows done is `done`. */
export const coreResult = (outcome: DesktopOutcome): CirceComputerUseResult => {
  switch (outcome.status) {
    case "done":
      return { status: "done", message: outcome.said, steps: outcome.actions };
    case "cancelled":
      return { status: "cancelled", message: outcome.said, steps: outcome.actions };
    case "clarify":
      return { status: "needs-input", message: outcome.said };
    case "unavailable":
      return { status: "unavailable", message: outcome.said };
    case "unverified":
    case "uncertain":
    case "refused":
    case "unsupported":
      return { status: "refused", message: outcome.said };
  }
};

const isComputerUnavailableError = Schema.is(ComputerUnavailableError);

/** A grounded step failed before or while it ran; the mission refuses honestly. */
export class ComputerStepError extends Schema.TaggedError<ComputerStepError>()(
  "ComputerStepError",
  { message: Schema.String },
) {}

/**
 * The window offers no controls Circe can target, and reading the screen is
 * unavailable on this node. The mission reports the limitation instead of
 * guessing at pixels.
 */
export class ComputerGroundingUnavailableError extends Schema.TaggedError<ComputerGroundingUnavailableError>()(
  "ComputerGroundingUnavailableError",
  { message: Schema.String },
) {}

/** circe-core's executor itself failed; what it did before that is unknown. */
export class DesktopGoalFailed extends Schema.TaggedError<DesktopGoalFailed>()(
  "DesktopGoalFailed",
  { cause: Schema.Defect() },
) {}

/** Input may have been delivered; the mission must not repeat or hide that. */
export class ComputerActionUncertainError extends Schema.TaggedError<ComputerActionUncertainError>()(
  "ComputerActionUncertainError",
  { message: Schema.String },
) {}

/** circe-core's whole-goal executor and the Jev route it asks through. */
export interface DesktopCore {
  readonly runDesktopGoal: NonNullable<CirceCore["runDesktopGoal"]>;
  readonly jev: Jev;
}

/**
 * The installed circe-core, when it carries out whole goals (0.4 and later).
 * Without it, missions keep the node's own step loop.
 */
export const installedDesktopCore = Effect.gen(function* () {
  const core = yield* Effect.promise(loadCirceCore);
  if (core?.runDesktopGoal === undefined) return undefined;
  // Jev itself, through the same route as Circe's interpreter: never the
  // provider-first judgement the node's own step loop is given.
  const decision = yield* CirceDecision.pipe(Effect.provide(CirceDecisionLive));
  const route = yield* makeJevRoute(decision);
  return { runDesktopGoal: core.runDesktopGoal, jev: route(core) } satisfies DesktopCore;
});

export const make = <R = never>(
  options: { readonly desktop?: Effect.Effect<DesktopCore | undefined, never, R> } = {},
) =>
  Effect.gen(function* () {
    const service = yield* ComputerService;
    // The decision tier is optional: a node without it has no step model, so a
    // mission reports `unavailable` instead of refusing to build the layer.
    const decisionOpt = yield* Effect.serviceOption(CirceDecision);
    const decision = Option.getOrElse(decisionOpt, () => ({
      decide: (_request: DecisionRequest) =>
        Effect.succeed({ status: "decline", reason: "decision-disabled" } as const),
    }));
    const cancellation = yield* CirceMissionCancellation;
    const recoveryOpt = yield* Effect.serviceOption(CirceRecoveryPlanner);
    const recovery = Option.getOrUndefined(recoveryOpt);
    const desktopCore = options.desktop === undefined ? undefined : yield* options.desktop;
    const runDesktopGoal = desktopCore?.runDesktopGoal;
    const jev = desktopCore?.jev;
    const context = yield* Effect.context<never>();

    /**
     * One goal carried out by circe-core inside `mission`, which may be this
     * executor's own or the one a provider session was granted. Every
     * observation and action is a call in that mission, under its owner; a
     * stop reaches circe-core before its next action, and interrupting this
     * effect aborts it.
     */
    const execute = (
      mission: ComputerMission,
      goal: CirceComputerGoal,
    ): Effect.Effect<CirceComputerUseResult> =>
      Effect.gen(function* () {
        if (runDesktopGoal === undefined || jev === undefined)
          return {
            status: "unavailable",
            message: "This computer can't carry out whole desktop goals.",
          } as const;
        const status = yield* service.status;
        const stop = new AbortController();
        const run = <A, X>(effect: Effect.Effect<A, X>, signal?: AbortSignal) =>
          Effect.runPromiseWith(context)(effect, signal === undefined ? undefined : { signal });
        const host = makeCoreDesktopHost({
          call: (tool, args) =>
            service.call({ missionId: mission.id, tool, args, owner: mission.owner }),
          platform: cuaPlatform(status.host?.platform),
          visualAvailable: service.status.pipe(
            Effect.map((current) => current.host?.capabilities.visualGrounding === true),
          ),
          run,
          stopped: goal.stopped,
          onStopped: () => stop.abort(),
        });
        const stopWatcher = yield* Effect.forkChild(
          Effect.gen(function* () {
            for (;;) {
              if (yield* goal.stopped) {
                stop.abort();
                return;
              }
              yield* Effect.sleep("100 millis");
            }
          }),
        );
        const outcome = yield* Effect.tryPromise({
          try: (interrupted) => {
            const signal = AbortSignal.any([interrupted, stop.signal]);
            return runDesktopGoal({
              goal: goal.goal,
              host,
              jev,
              ...(recovery === undefined
                ? {}
                : {
                    planner: {
                      plan: ({ prompt, signal: planSignal }) =>
                        run(recovery.planDesktop(prompt), planSignal),
                    },
                  }),
              ...(goal.plan === undefined ? {} : { plan: goal.plan }),
              ...(goal.application === undefined ? {} : { app: goal.application }),
              ...(goal.typeText === undefined ? {} : { text: goal.typeText }),
              signal,
              onProgress: (progress) => {
                void run(Effect.logInfo("desktop progress", progress));
                goal.onProgress?.(progress.text);
              },
            });
          },
          catch: (cause) => new DesktopGoalFailed({ cause }),
        }).pipe(
          Effect.ensuring(Fiber.interrupt(stopWatcher)),
          Effect.catchTag("DesktopGoalFailed", (error) =>
            Effect.logError("desktop goal failed", {
              goal: goal.goal,
              cause: String(error.cause),
            }).pipe(Effect.as(undefined)),
          ),
        );
        if (outcome === undefined)
          return {
            status: "refused",
            message:
              "Something went wrong while I was using the desktop. Check the screen before trying again.",
          } as const;
        goal.onFinished?.(outcome);
        yield* Effect.logInfo("desktop goal", {
          goal: goal.goal,
          status: outcome.status,
          actions: outcome.actions,
          metrics: outcome.metrics,
          trace: outcome.trace,
        });
        return coreResult(outcome);
      });

    type RunError =
      | ComputerStepError
      | ComputerGroundingUnavailableError
      | ComputerActionUncertainError
      | SurfaceDecisionUnavailableError
      | DesktopElementChangedError
      | ComputerUnavailableError
      | ComputerMissionError;

    const run = Effect.fn("CirceComputerUse.run")(function* (input: CirceComputerUseInput) {
      const requestId = input.requestMetadata?.requestId;
      if (input.confirmed !== true) {
        return {
          status: "needs-input",
          message: confirmationMessage(input.goal),
        } as const;
      }
      const status = yield* service.status;
      if (!status.available) {
        return {
          status: "unavailable",
          message:
            status.host?.reason ??
            "Computer use is unavailable on this node; no desktop host is connected.",
        } as const;
      }

      // Register before the mission exists so a stop that arrives during
      // startup cannot be lost; a failed start releases it again.
      if (requestId !== undefined) yield* cancellation.register(requestId);
      const begun = yield* Effect.result(
        service.beginMission({
          goal: input.goal,
          source: requestId === undefined ? "ui" : "voice",
          owner: { kind: "client" },
          ...(requestId === undefined ? {} : { requestId }),
        }),
      );
      if (Result.isFailure(begun)) {
        if (requestId !== undefined) yield* cancellation.clear(requestId);
        return isComputerUnavailableError(begun.failure)
          ? ({ status: "unavailable", message: begun.failure.message } as const)
          : ({ status: "refused", message: begun.failure.message } as const);
      }
      const mission: ComputerMission = begun.success;
      const platform = cuaPlatform(status.host?.platform);
      /**
       * Read per observation: the driver runtime starts with the mission's
       * first call and the perception extension may finish installing during
       * the mission, so the status read before the mission is not the answer.
       */
      const visualGrounding = service.status.pipe(
        Effect.map((current) => current.host?.capabilities.visualGrounding === true),
      );
      const stopped = () =>
        requestId === undefined ? Effect.succeed(false) : cancellation.isCancelled(requestId);

      // A stop must reach native input, not only the loop's next gate: while
      // the mission runs this watcher asks the host to interrupt in-flight
      // input as soon as the user cancels.
      const stopWatcher = yield* Effect.forkChild(
        Effect.gen(function* () {
          for (;;) {
            if (yield* stopped()) {
              yield* service.stop(mission.id);
              return;
            }
            yield* Effect.sleep("100 millis");
          }
        }),
      );

      const legacy = Effect.gen(function* () {
        const missionId = mission.id;

        /**
         * One exact dispatch. A verified effect succeeds. A dispatch the driver
         * completed but could not verify (a pixel click, say) is delivered
         * input with an unobserved effect: it succeeds unconfirmed, the loop
         * reobserves, and the goal check decides; nothing retries it. Input
         * whose delivery itself is unknown (the call was interrupted, timed
         * out or failed mid-dispatch) stops the mission.
         */
        const dispatch = (tool: string, args: Record<string, unknown>) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            const result = yield* service.call({
              missionId,
              tool,
              args,
              owner: mission.owner,
            });
            yield* Effect.logInfo("desktop action", {
              tool,
              effect: result.effect,
              driverCode: result.driverCode,
              actionMs: (yield* Clock.currentTimeMillis) - started,
            });
            return result;
          });

        /**
         * A clean dispatch whose effect the driver could not verify proceeds
         * to a fresh observation; the goal check decides whether it worked. After a launch,
         * target resolution waits for the named application's window before
         * any input is allowed. A launch is never retried.
         */
        const settle = (tool: string, result: ComputerHostToolResult) =>
          Effect.gen(function* () {
            switch (result.effect) {
              case "verified":
                if (result.isError)
                  return yield* new ComputerStepError({
                    message: result.text.length > 0 ? result.text : `The ${tool} step failed.`,
                  });
                return result;
              case "dispatched-unknown":
                if (!result.isError) return result;
                return yield* new ComputerActionUncertainError({
                  message:
                    result.text.length > 0
                      ? `${result.text} Its delivery is unknown, so I won't repeat it.`
                      : `The ${tool} step may or may not have landed, so I won't repeat it.`,
                });
              case "refused":
              case "not-dispatched":
                return yield* new ComputerStepError({
                  message:
                    result.text.length > 0 ? result.text : `The ${tool} step was not dispatched.`,
                });
            }
          });

        const callMutation = (tool: string, args: Record<string, unknown>) =>
          dispatch(tool, args).pipe(Effect.flatMap((result) => settle(tool, result)));

        /** A read that must fail the mission on driver errors. */
        const callRead = (tool: string, args: Record<string, unknown>) =>
          Effect.gen(function* () {
            const result = yield* service.call({
              missionId,
              tool,
              args,
              owner: mission.owner,
            });
            if (result.isError)
              return yield* new ComputerStepError({
                message: result.text.length > 0 ? result.text : `The ${tool} step failed.`,
              });
            return result;
          });

        /** Dispatch once, then resolveTarget verifies the application window. */
        const launchApp = (args: Record<string, unknown>) =>
          dispatch("launch_app", args).pipe(
            Effect.flatMap((result) => settle("launch_app", result)),
            Effect.map((result) => readLaunchPid(result.structured)),
          );

        /** A read used for observation fallbacks; failure returns undefined. */
        const callSoft = (
          tool: string,
          args: Record<string, unknown>,
        ): Effect.Effect<ComputerHostToolResult | undefined> =>
          callRead(tool, args).pipe(Effect.catch(() => Effect.succeed(undefined)));

        const listWindows = () =>
          callSoft("list_windows", { on_screen_only: true }).pipe(
            Effect.map((result) => (result === undefined ? [] : readWindows(result.structured))),
          );

        const listApps = () =>
          callSoft("list_apps", {}).pipe(
            Effect.map((result) => (result === undefined ? [] : readApps(result.structured))),
          );

        /**
         * The frontmost window, optionally restricted to one app. Z order is
         * used when the driver reports it; otherwise the active app's window
         * decides. Anything else is ambiguous and returns undefined rather
         * than substituting an unrelated window in list order.
         */
        const pickWindow = (
          windows: ReadonlyArray<CuaWindow>,
          apps: ReadonlyArray<CuaApp>,
          appName?: string,
          pid?: number,
        ): CuaWindow | undefined => {
          const candidates = windows.filter(
            (window) =>
              window.is_on_screen !== false &&
              (pid !== undefined
                ? window.pid === pid
                : appName === undefined || window.app_name.toLowerCase() === appName.toLowerCase()),
          );
          if (candidates.length === 0) return undefined;
          const ranked = candidates.filter((window) => typeof window.z_index === "number");
          if (ranked.length > 0)
            return [...ranked].sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))[0];
          const activeNames = new Set(
            apps.filter((app) => app.active === true).map((app) => app.name.toLowerCase()),
          );
          const active = candidates.filter((window) =>
            activeNames.has(window.app_name.toLowerCase()),
          );
          if (active.length === 1) return active[0];
          if (candidates.length === 1) return candidates[0];
          return undefined;
        };

        const waitForWindow = (appName: string, pid?: number) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + WINDOW_READY_TIMEOUT_MS;
            for (;;) {
              const window = pickWindow(yield* listWindows(), [], appName, pid);
              if (window !== undefined) return window;
              if ((yield* Clock.currentTimeMillis) >= deadline) return undefined;
              yield* Effect.sleep(WINDOW_POLL_MS);
            }
          });

        const pinnedApplication = input.target?.application;
        const startUrl = (() => {
          for (const candidate of extractWebsiteCandidates(input.goal)) {
            const url = circeWebsiteUrl(candidate, input.goal);
            if (url !== null) return url;
          }
          return null;
        })();
        const targetFromWindow = (window: CuaWindow): MissionTarget => ({
          pid: window.pid,
          windowId: window.window_id,
          appName: window.app_name,
          title: window.title,
        });

        const resolveTarget = (): Effect.Effect<MissionTarget | undefined, RunError> =>
          Effect.gen(function* () {
            const windows = yield* listWindows();
            const apps = yield* listApps();
            const running = apps.filter((app) => app.running && app.pid > 0);

            if (pinnedApplication !== undefined) {
              const installed = resolveDesktopApp(
                pinnedApplication,
                apps.map((app) => app.name),
              );
              const wanted = installed ?? pinnedApplication;
              const pinnedRunning = running.find(
                (app) => app.name.toLowerCase() === wanted.toLowerCase(),
              );
              const pid = pinnedRunning?.pid ?? (yield* launchApp({ name: wanted }));
              const window = yield* waitForWindow(wanted, pid);
              return window === undefined ? undefined : targetFromWindow(window);
            }

            if (startUrl !== null) {
              let browser = running.find((app) => BROWSER_APP_PATTERN.test(app.name));
              const baseline = new Set(windows.map((window) => window.window_id));
              yield* launchApp({ urls: [startUrl] });
              const deadline = (yield* Clock.currentTimeMillis) + WINDOW_READY_TIMEOUT_MS;
              for (;;) {
                const fresh = (yield* listWindows()).filter(
                  (window) => !baseline.has(window.window_id),
                );
                // Only a browser window can be the mission target. An unrelated
                // window that appeared during the launch is never selected.
                const freshBrowser = fresh.find((window) =>
                  browser === undefined
                    ? BROWSER_APP_PATTERN.test(window.app_name)
                    : window.app_name.toLowerCase() === browser.name.toLowerCase(),
                );
                if (freshBrowser !== undefined) return targetFromWindow(freshBrowser);
                if ((yield* Clock.currentTimeMillis) >= deadline) break;
                yield* Effect.sleep(WINDOW_POLL_MS);
              }
              // The URL may have opened a tab in an already-running browser
              // window, or the browser may have started under a name we did
              // not know before the launch. Resolve the exact browser app and
              // use one of its windows, or refuse.
              if (browser === undefined) {
                const apps = yield* listApps();
                browser = apps.find((app) => app.running && BROWSER_APP_PATTERN.test(app.name));
              }
              if (browser !== undefined) {
                const window = pickWindow(yield* listWindows(), [], browser.name);
                if (window !== undefined) return targetFromWindow(window);
              }
              return undefined;
            }

            const resolvedRunning = resolveDesktopApp(
              input.goal,
              running.map((app) => app.name),
            );
            if (resolvedRunning !== undefined) {
              const pid = running.find((app) => app.name === resolvedRunning)?.pid;
              const window = pickWindow(windows, apps, resolvedRunning, pid);
              if (window !== undefined) return targetFromWindow(window);
              const awaited = yield* waitForWindow(resolvedRunning, pid);
              return awaited === undefined ? undefined : targetFromWindow(awaited);
            }

            // A goal may name an installed app that is not running yet; that
            // is where it launches, before any unrelated frontmost window is
            // considered.
            const resolvedInstalled = resolveDesktopApp(
              input.goal,
              apps.map((app) => app.name),
            );
            if (resolvedInstalled !== undefined) {
              const pid = yield* launchApp({ name: resolvedInstalled });
              const window = yield* waitForWindow(resolvedInstalled, pid);
              return window === undefined ? undefined : targetFromWindow(window);
            }

            const frontmost = pickWindow(windows, apps);
            return frontmost === undefined ? undefined : targetFromWindow(frontmost);
          });

        let target = yield* resolveTarget();
        if (target === undefined) {
          return {
            status: "unavailable",
            message:
              pinnedApplication !== undefined
                ? `The application "${pinnedApplication}" is not available on this node's desktop.`
                : "I couldn't tell which window to work with. Name the application in your request.",
          } as const;
        }

        /**
         * The newest grounded observation. Every action resolves its element
         * here, so a candidate is only ever acted on through the executable
         * address of the observation the model chose it from.
         */
        let latest: GroundedObservation | undefined;
        /** Captures that already authorized an action. A capture authorizes one. */
        const consumedCaptures = new Set<string>();

        const observeTarget = (mode: "auto" | "visual" = "auto") =>
          Effect.gen(function* () {
            const active = target;
            if (active === undefined)
              return {
                kind: "desktop" as const,
                title: "",
                elements: [],
              } satisfies ComputerSurface;
            const visualAvailable = yield* visualGrounding;
            const observation = yield* observeGrounded({
              call: (tool, args) => service.call({ missionId, tool, args, owner: mission.owner }),
              target: { pid: active.pid, windowId: active.windowId },
              platform,
              visualAvailable,
              mode,
              app: active.appName,
            }).pipe(
              Effect.catchTag("GroundingError", (error: GroundingError) =>
                Effect.fail(new ComputerStepError({ message: error.reason })),
              ),
            );
            yield* Effect.logInfo("desktop observation", {
              pid: active.pid,
              windowId: active.windowId,
              ...observation.report,
            });
            latest = observation;
            const title = observation.title ?? active.title;
            target = {
              pid: active.pid,
              windowId: active.windowId,
              appName: observation.appName ?? active.appName,
              title,
            };
            const reachable = observation.elements.filter(
              (element) => element.role !== "window" && element.role !== "frame",
            );
            if (
              observation.report.fallback !== undefined &&
              observation.report.fallback !== "escalated" &&
              observation.report.visual === "unavailable" &&
              reachable.length === 0
            )
              return yield* new ComputerGroundingUnavailableError({
                message: `${target.appName} does not expose its controls to accessibility, and reading the screen is unavailable on this node, so I can't act in that window.`,
              });
            return {
              kind: "desktop" as const,
              title,
              ...(observation.snapshotId === undefined
                ? {}
                : { observationRef: observation.snapshotId }),
              ...(observation.degraded ? { degraded: true } : {}),
              elements: observation.elements,
            } satisfies ComputerSurface;
          });

        const observe = (mode: "auto" | "visual" = "auto") =>
          observeTarget(mode).pipe(
            Effect.map((surface) => ({
              ...surface,
              elements: rankSurfaceForGoal(surface.elements, input.goal),
            })),
          );

        /**
         * A richer look at the same window: parse its capture even though the
         * accessibility tree was usable. Offered once per step when the model
         * could not ground a step, and only when visual grounding exists.
         */
        const escalate = () =>
          latest === undefined || latest.report.visual !== "skipped"
            ? Effect.succeed(undefined)
            : observe("visual").pipe(
                Effect.map((surface) =>
                  latest !== undefined && latest.report.visualCandidates > 0 ? surface : undefined,
                ),
              );

        /**
         * One exact dispatch per action, bound to the mission's target window.
         * The driver picks its own delivery route inside the call; there is no
         * caller-side fallback that could repeat input or weaken the target.
         */
        /**
         * Click a grounded candidate through the executable address of the
         * observation it came from: a native element token, or a point bound to
         * the exact capture it was read from. A consumed capture never
         * authorizes a second click, and a refused capture or stale token is
         * reported as not applied so the loop reobserves; neither is retried
         * through a weaker address.
         */
        const clickElement = (element: ComputerElement) =>
          Effect.gen(function* () {
            const observation = latest;
            const executable = observation?.executables.get(element.id);
            if (observation === undefined || executable === undefined) return false;
            if (
              observation.target.pid !== target!.pid ||
              observation.target.windowId !== target!.windowId
            )
              return false;
            if (executable.kind === "visual") {
              if (consumedCaptures.has(executable.captureId)) return false;
              consumedCaptures.add(executable.captureId);
            }
            const result = yield* dispatch("click", clickArguments(observation.target, executable));
            const code = result.driverCode;
            if (
              (result.effect === "refused" || result.effect === "not-dispatched") &&
              code !== undefined &&
              (CAPTURE_REFUSAL_CODES.has(code) || code === "stale_element_token")
            )
              return false;
            yield* settle("click", result);
            return true;
          });

        const typeIntoElement = (element: ComputerElement, text: string) =>
          Effect.gen(function* () {
            const executable = latest?.executables.get(element.id);
            if (executable?.kind !== "native") return false;
            // A fill replaces through the guarded set_value mutation;
            // type_text appends and must not implement one.
            const result = yield* dispatch("set_value", {
              pid: target!.pid,
              window_id: target!.windowId,
              element_token: executable.token,
              value: text,
              delivery_mode: "background",
            });
            if (
              (result.effect === "refused" || result.effect === "not-dispatched") &&
              result.driverCode === "stale_element_token"
            )
              return false;
            yield* settle("set_value", result);
            return true;
          });

        const actuator = {
          click: (element: ComputerElement) => clickElement(element),
          typeInto: (element: ComputerElement, text: string) => typeIntoElement(element, text),
          pressKey: (key: string) =>
            callMutation("press_key", {
              pid: target!.pid,
              window_id: target!.windowId,
              key,
              delivery_mode: "background",
            }).pipe(Effect.asVoid),
          typeText: (text: string) =>
            callMutation("type_text", {
              pid: target!.pid,
              window_id: target!.windowId,
              text,
              delivery_mode: "background",
            }).pipe(Effect.asVoid),
          scroll: (direction: DesktopScrollDirection) =>
            callMutation("scroll", {
              pid: target!.pid,
              window_id: target!.windowId,
              direction,
              amount: SCROLL_LINES,
              by: "line",
              delivery_mode: "background",
            }).pipe(Effect.asVoid),
          wait: () => Effect.sleep(WAIT_MS),
        };

        const select = (request: DecisionRequest) =>
          decision.decide(request).pipe(
            Effect.timed,
            Effect.tap(([duration]) =>
              Effect.logInfo("desktop decision", {
                decideMs: Math.round(Duration.toMillis(duration)),
              }),
            ),
            Effect.map(([, outcome]) => outcome),
            Effect.tap((outcome) =>
              Effect.logDebug("desktop step decision", {
                status: outcome.status,
                model: outcome.status === "answered" ? outcome.model : outcome.reason,
              }),
            ),
            Effect.flatMap((outcome) =>
              outcome.status === "answered"
                ? Effect.succeed(outcome.answers)
                : Effect.fail(new SurfaceDecisionUnavailableError({ reason: outcome.reason })),
            ),
          );

        const verifySurface = (check: {
          readonly goal: string;
          readonly surface: Parameters<typeof buildComputerVerificationRequest>[0]["surface"];
          readonly history: ReadonlyArray<string>;
          readonly summary: string;
          readonly surfaceChangedSinceStart?: boolean;
          readonly surfaceChangedAfterLastAction?: boolean;
        }): Effect.Effect<boolean> =>
          decision
            .decide(
              buildComputerVerificationRequest({
                model: DECISION_MODEL,
                goal: check.goal,
                surface: check.surface,
                history: check.history,
                summary: check.summary,
                ...(check.surfaceChangedSinceStart === undefined
                  ? {}
                  : { surfaceChangedSinceStart: check.surfaceChangedSinceStart }),
                ...(check.surfaceChangedAfterLastAction === undefined
                  ? {}
                  : { surfaceChangedAfterLastAction: check.surfaceChangedAfterLastAction }),
              }),
            )
            .pipe(
              Effect.map(
                (outcome) =>
                  outcome.status === "answered" && computerGoalVerified(outcome.answers) === true,
              ),
              Effect.orElseSucceed(() => false),
              Effect.timed,
              Effect.tap(([duration, verified]) =>
                Effect.logInfo("desktop verification", {
                  verified,
                  verifyMs: Math.round(Duration.toMillis(duration)),
                }),
              ),
              Effect.map(([, verified]) => verified),
            );

        const verify = (check: Parameters<typeof verifySurface>[0]): Effect.Effect<boolean> =>
          Effect.gen(function* () {
            if (yield* verifySurface(check)) return true;
            if (!(yield* visualGrounding)) return false;
            // A usable accessibility tree can expose controls without their
            // displayed result (GTK calculator text, canvas output). Read the
            // same window once before rejecting an otherwise completed goal.
            const richer = yield* escalate().pipe(Effect.catch(() => Effect.succeed(undefined)));
            return richer === undefined
              ? false
              : yield* verifySurface({ ...check, surface: richer });
          });

        const expectation = inferComputerExpectation(input.goal);
        let handoff:
          | { readonly history: ReadonlyArray<string>; readonly applied: number }
          | undefined;
        const singleClick = singleClickTarget(input.goal);
        if (singleClick !== undefined) {
          const before = yield* observe().pipe(Effect.catch(() => Effect.succeed(null)));
          if (before !== null) {
            const fold = (value: string): string =>
              value
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, " ")
                .trim();
            const normalized = fold(singleClick);
            const named = before.elements.filter(
              (element) => element.role !== "frame" && element.role !== "window",
            );
            const exact = named.filter((element) => fold(element.name) === normalized);
            const partial =
              exact.length > 0
                ? exact
                : named.filter((element) => {
                    const name = fold(element.name);
                    return (
                      name.length >= 2 &&
                      (name.includes(normalized) ||
                        (normalized.length >= 2 && normalized.includes(name)))
                    );
                  });
            const actionable: ReadonlySet<string> = new Set([
              "button",
              "push button",
              "toggle button",
              "list item",
              "menu item",
              "check box",
              "radio button",
              "link",
              "tab",
              "page tab",
              "combo box",
              "entry",
              "text",
            ]);
            const control =
              partial.length === 1
                ? partial
                : partial.filter((element) => actionable.has(fold(element.role ?? "")));
            if (control.length === 1) {
              if (yield* stopped())
                return { status: "cancelled" as const, message: "Stopped.", steps: 0 };
              const element = control[0]!;
              // A dispatched click is the evidence; uncertainty propagates and
              // the mission reports it instead of claiming done. A click that
              // dispatched nothing hands the goal to the loop untouched.
              const clicked = yield* actuator.click(element);
              if (clicked) {
                if (expectation.kind === "action") {
                  return { status: "done" as const, message: `Done: ${input.goal}`, steps: 1 };
                }
                const digest = (surface: ComputerSurface): string =>
                  surface.elements
                    .map(
                      (entry) =>
                        `${entry.role ?? ""}\u0001${entry.name}\u0001${entry.value ?? ""}\u0001${entry.state ?? ""}`,
                    )
                    .join("\u0002");
                const baseline = digest(before);
                let changed = false;
                for (let attempt = 0; attempt < 6 && !changed; attempt += 1) {
                  if (attempt > 0) yield* Effect.sleep(300);
                  const observed = yield* observe().pipe(Effect.catch(() => Effect.succeed(null)));
                  if (observed !== null) changed = digest(observed) !== baseline;
                }
                if (changed) {
                  return { status: "done" as const, message: `Done: ${input.goal}`, steps: 1 };
                }
                handoff = { history: [`clicked ${element.name}`], applied: 1 };
              }
            }
          }
        }

        return yield* runComputerUse({
          model: DECISION_MODEL,
          goal: input.goal,
          expectation,
          ...(handoff === undefined
            ? {}
            : { initialHistory: handoff.history, initialApplied: handoff.applied }),
          ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
          ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
          ...(requestId === undefined
            ? {}
            : { shouldStop: () => cancellation.isCancelled(requestId) }),
          verify,
          ...(recovery === undefined ? {} : { replan: recovery.plan, plan: recovery.planGoal }),
          runtime: makeDesktopUseRuntime<RunError>({
            observe: () => observe(),
            select,
            actuator,
            escalate,
          }),
        }).pipe(Effect.map((result) => mapResult(result, input.goal)));
      });

      const body =
        runDesktopGoal === undefined
          ? legacy
          : execute(mission, {
              goal: input.goal,
              stopped: stopped(),
              ...(input.target?.application === undefined
                ? {}
                : { application: input.target.application }),
              ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
            });

      return yield* body.pipe(
        Effect.catchTag("SurfaceDecisionUnavailableError", (error) =>
          Effect.succeed({ status: "unavailable" as const, message: error.message }),
        ),
        Effect.catchTag("DesktopElementChangedError", (error) =>
          Effect.succeed({ status: "refused" as const, message: error.message }),
        ),
        Effect.catchTag("ComputerUnavailableError", (error) =>
          Effect.succeed({ status: "unavailable" as const, message: error.message }),
        ),
        Effect.catchTag("ComputerMissionError", (error) =>
          Effect.succeed({ status: "refused" as const, message: error.message }),
        ),
        Effect.catchTag("ComputerActionUncertainError", (error) =>
          Effect.succeed({ status: "refused" as const, message: error.message }),
        ),
        Effect.catchTag("ComputerStepError", (error) =>
          Effect.succeed({ status: "refused" as const, message: error.message }),
        ),
        Effect.catchTag("ComputerGroundingUnavailableError", (error) =>
          Effect.succeed({ status: "unavailable" as const, message: error.message }),
        ),
        Effect.tapCause((cause) =>
          Effect.logError("desktop mission failed", {
            goal: input.goal,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.catch(() =>
          Effect.succeed({
            status: "refused" as const,
            message: "I couldn't drive the desktop for that request.",
          }),
        ),
        // Teardown order matters: finish host-side cleanup before releasing the
        // cancellation registration, so a cleared registration proves the
        // driver has no session left for this mission.
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Fiber.interrupt(stopWatcher);
            yield* service
              .endMission({ missionId: mission.id, reason: "settled" })
              .pipe(Effect.catch(() => Effect.void));
            if (requestId !== undefined) yield* cancellation.clear(requestId);
          }),
        ),
      );
    });

    /**
     * A goal inside a mission its owner already holds, such as a provider
     * session's granted mission. No second mission starts, and the mission
     * stays open for its owner afterwards.
     */
    const runInMission = (mission: ComputerMission, goal: CirceComputerGoal) =>
      execute(mission, goal).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("desktop goal failed", {
            goal: goal.goal,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.as({
              status: "refused" as const,
              message:
                "Something went wrong while I was using the desktop. Check the screen before trying again.",
            }),
          ),
        ),
      );

    return CirceComputerUse.of({ run, runInMission, wholeGoals: runDesktopGoal !== undefined });
  });

export const CirceComputerUseLive = Layer.effect(
  CirceComputerUse,
  make({ desktop: installedDesktopCore }),
);
