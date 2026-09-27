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
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  groundElements,
  observationIsPartial,
  readApps,
  readWindowState,
  readWindows,
  type CuaApp,
  type CuaWindow,
} from "../../computer/driverSchemas.ts";
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
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
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
 * Effects are preserved end to end: a driver action either reports a verified
 * effect, or the mission reports uncertainty and stops. No path turns an
 * unknown effect into success, and no path retries the same step through a
 * weaker target.
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

const isComputerUnavailableError = Schema.is(ComputerUnavailableError);

/** A grounded step failed before or while it ran; the mission refuses honestly. */
export class ComputerStepError extends Schema.TaggedError<ComputerStepError>()(
  "ComputerStepError",
  { message: Schema.String },
) {}

/** Input may have been delivered; the mission must not repeat or hide that. */
export class ComputerActionUncertainError extends Schema.TaggedError<ComputerActionUncertainError>()(
  "ComputerActionUncertainError",
  { message: Schema.String },
) {}

export const make = () =>
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

    type RunError =
      | ComputerStepError
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

      const body = Effect.gen(function* () {
        const missionId = mission.id;

        /**
         * A mutation is only a success when the driver reports a verified
         * effect. An uncertain effect fails the step so the mission can report
         * it, never so the loop can retry it.
         */
        const callMutation = (tool: string, args: Record<string, unknown>) =>
          Effect.gen(function* () {
            const result = yield* service.call({
              missionId,
              tool,
              args,
              owner: mission.owner,
            });
            switch (result.effect) {
              case "verified":
                if (result.isError)
                  return yield* new ComputerStepError({
                    message: result.text.length > 0 ? result.text : `The ${tool} step failed.`,
                  });
                return result;
              case "dispatched-unknown":
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

        /** A launch is a mutation: its refusal or uncertainty must not be swallowed. */
        const launchApp = (args: Record<string, unknown>) =>
          callMutation("launch_app", args).pipe(Effect.asVoid);

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
        ): CuaWindow | undefined => {
          const candidates = windows.filter(
            (window) =>
              window.is_on_screen !== false &&
              (appName === undefined || window.app_name.toLowerCase() === appName.toLowerCase()),
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

        const waitForWindow = (appName: string) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + WINDOW_READY_TIMEOUT_MS;
            for (;;) {
              const window = pickWindow(yield* listWindows(), [], appName);
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
              if (pinnedRunning === undefined) {
                yield* launchApp({ name: wanted });
              }
              const window = yield* waitForWindow(wanted);
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
              const window = pickWindow(windows, apps, resolvedRunning);
              if (window !== undefined) return targetFromWindow(window);
              const awaited = yield* waitForWindow(resolvedRunning);
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
              yield* launchApp({ name: resolvedInstalled });
              const window = yield* waitForWindow(resolvedInstalled);
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

        const observeTarget = () =>
          Effect.gen(function* () {
            const active = target;
            if (active === undefined)
              return {
                kind: "desktop" as const,
                title: "",
                elements: [],
              } satisfies ComputerSurface;
            const result = yield* callRead("get_window_state", {
              pid: active.pid,
              window_id: active.windowId,
              include_screenshot: false,
            });
            const state = readWindowState(result.structured);
            if (state === undefined)
              return {
                kind: "desktop" as const,
                title: active.title,
                elements: [],
              } satisfies ComputerSurface;
            const elements: ReadonlyArray<ComputerElement> = groundElements(state).map(
              (element) => ({
                id: element.token,
                role: element.role,
                name: element.name,
                ...(element.value === undefined ? {} : { value: element.value }),
                ...(element.state === undefined ? {} : { state: element.state }),
                app: state.app_name ?? active.appName,
                bounds: element.bounds,
              }),
            );
            const title = state.window_title ?? active.title;
            target = {
              pid: active.pid,
              windowId: active.windowId,
              appName: state.app_name ?? active.appName,
              title,
            };
            return {
              kind: "desktop" as const,
              title,
              ...(state.snapshot_id === undefined || state.snapshot_id === null
                ? {}
                : { observationRef: state.snapshot_id }),
              ...(observationIsPartial(state) ? { degraded: true } : {}),
              elements,
            } satisfies ComputerSurface;
          });

        const observe = () =>
          observeTarget().pipe(
            Effect.map((surface) => ({
              ...surface,
              elements: rankSurfaceForGoal(surface.elements, input.goal),
            })),
          );

        /**
         * One exact dispatch per action, bound to the mission's target window.
         * The driver picks its own delivery route inside the call; there is no
         * caller-side fallback that could repeat input or weaken the target.
         */
        const clickElement = (element: ComputerElement) =>
          callMutation("click", {
            pid: target!.pid,
            window_id: target!.windowId,
            element_token: element.id,
            delivery_mode: "background",
          }).pipe(Effect.asVoid);

        const typeIntoElement = (element: ComputerElement, text: string) =>
          callMutation("type_text", {
            pid: target!.pid,
            window_id: target!.windowId,
            element_token: element.id,
            text,
            delivery_mode: "background",
          }).pipe(Effect.asVoid);

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

        const verify = (check: {
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
            );

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
              // A verified click is the evidence; uncertainty propagates and
              // the mission reports it instead of claiming done.
              yield* actuator.click(element);
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
            observe,
            select,
            actuator,
          }),
        }).pipe(Effect.map((result) => mapResult(result, input.goal)));
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

    return CirceComputerUse.of({ run });
  });

export const CirceComputerUseLive = Layer.effect(CirceComputerUse, make());
