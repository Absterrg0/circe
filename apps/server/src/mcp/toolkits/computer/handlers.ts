import { McpCapabilityUnavailableError, type ComputerHostToolResult } from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  ComputerService,
  type ComputerMission,
  type ComputerMissionOwner,
  type ComputerServiceShape,
} from "../../../computer/ComputerService.ts";
import { cuaPlatform } from "../../../computer/cuaObservation.ts";
import { readApps, readWindows, type CuaWindow } from "../../../computer/driverSchemas.ts";
import {
  CAPTURE_REFUSAL_CODES,
  clickArguments,
  observeGrounded,
  type GroundedObservation,
} from "../../../computer/grounding.ts";
import { CirceComputerAccess } from "../../../circe/Services/CirceComputerAccess.ts";
import {
  CirceComputerUse,
  type CirceComputerGoal,
} from "../../../circe/Services/CirceComputerUse.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ComputerToolkit,
  ComputerToolError,
  type ComputerActionResult,
  type ComputerDoResult,
} from "./tools.ts";

type ToolError = ComputerToolError;
const toolError = (code: string, message: string): ToolError =>
  new ComputerToolError({ code, message });

/** How long one computer_begin call waits on the user; below the providers' tool-call timeouts. */
const BEGIN_WAIT = "45 seconds";

const providerWindow = (window: CuaWindow) => ({
  windowId: Math.trunc(window.window_id),
  pid: window.pid,
  appName: window.app_name,
  title: window.title,
  onScreen: window.is_on_screen !== false,
});

const launchPid = Schema.decodeUnknownOption(
  Schema.Struct({ pid: Schema.optional(Schema.NullOr(Schema.Int)) }),
);

const missionOwnerFor = (invocation: {
  readonly threadId: string;
  readonly providerSessionId: string;
}): ComputerMissionOwner => ({
  kind: "provider",
  threadId: invocation.threadId,
  providerSessionId: invocation.providerSessionId,
});

/**
 * Only a verified effect is a success. An uncertain effect keeps its honest
 * classification and ok=false so the model reports uncertainty instead of
 * retrying or claiming the action landed.
 */
const toActionResult = (result: ComputerHostToolResult) => {
  const stale =
    result.driverCode !== undefined &&
    (CAPTURE_REFUSAL_CODES.has(result.driverCode) || result.driverCode === "stale_element_token");
  const refusal = result.driverCode ?? result.refusalCode;
  return {
    ok: !result.isError && result.effect === "verified",
    effect: result.effect,
    text: stale
      ? `${result.text} Nothing was dispatched; call computer_window_state again before acting.`
      : result.text,
    ...(refusal === undefined ? {} : { refusalCode: refusal }),
  };
};

/**
 * The newest observation handed to a provider, per mission. A controlId names
 * an element of exactly this observation; any action or newer observation
 * retires it, and a capture authorizes at most one click.
 */
interface ProviderObservation {
  readonly missionId: string;
  readonly sequence: number;
  readonly observation: GroundedObservation;
}

export const make = Effect.gen(function* () {
  const service = yield* ComputerService;
  const access = yield* CirceComputerAccess;
  const executor = yield* CirceComputerUse;
  const orchestrator = yield* OrchestratorV2;
  // Publish observations and consume them in one ordered lane. Serializing
  // only driver calls still permits two inputs to resolve the same snapshot.
  const observationLane = yield* Semaphore.make(1);
  // A completed whole goal spends its run's grant; another goal needs a new
  // mission and approval. Keyed by run alone so a reworded goal in the same
  // run returns the finished result instead of prompting again.
  const completedGoals = new Map<
    string,
    { readonly missionId: string; readonly result: ComputerDoResult }
  >();
  const rememberCompleted = (runId: string, missionId: string, result: ComputerDoResult) => {
    completedGoals.set(runId, { missionId, result });
    while (completedGoals.size > 20) {
      const oldest = completedGoals.keys().next();
      if (oldest.done === true) break;
      completedGoals.delete(oldest.value);
    }
  };
  const cleanGoal = (goal: string) => goal.replace(/\s+/gu, " ").trim().slice(0, 1_000);
  const requireCapability = () => McpInvocationContext.requireMcpCapability("computer-use");

  /**
   * Every call belongs to the node's active mission and to its owner. A
   * provider session may only act under a mission delegated to that exact
   * session; discovering the node's current mission grants nothing.
   */
  const withMission = <A, E, R>(
    run: (
      mission: ComputerMission,
      service: ComputerServiceShape,
      invocation: { readonly threadId: string; readonly providerSessionId: string },
    ) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      yield* requireCapability();
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const mission = yield* service.activeMission;
      const shell = yield* orchestrator
        .getThreadShell(invocation.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      const finished =
        shell?.activeRunId !== undefined && shell.activeRunId !== null
          ? completedGoals.get(shell.activeRunId)
          : undefined;
      if (finished !== undefined && (mission === undefined || finished.missionId === mission.id))
        return yield* Effect.fail(
          toolError(
            "mission-finished",
            `This whole goal ended with status ${finished.result.status}: ${finished.result.message} The computer has been handed back. Report that result; a new request from the user can start a new turn.`,
          ),
        );
      if (mission === undefined)
        return yield* Effect.fail(
          toolError(
            "mission-required",
            "This session holds no computer mission. Call computer_begin with your goal; the user approves it through Circe.",
          ),
        );
      if (
        mission.owner.kind !== "provider" ||
        mission.owner.threadId !== invocation.threadId ||
        mission.owner.providerSessionId !== invocation.providerSessionId
      )
        return yield* Effect.fail(
          toolError(
            "mission-owner-mismatch",
            "The computer is in use under a mission that belongs to someone else. Call computer_begin to ask for it once it is free.",
          ),
        );
      // The mission is this session's, but only for the run that was granted
      // it: a later run in the same session asks again.
      const held = yield* access.holds({
        providerSessionId: invocation.providerSessionId,
        runId: shell?.activeRunId ?? null,
      });
      if (!held)
        return yield* Effect.fail(
          toolError(
            "mission-required",
            "This run holds no computer mission. Call computer_begin with your goal; the user approves it through Circe.",
          ),
        );
      return yield* run(mission, service, invocation);
    }).pipe(observationLane.withPermit);

  const callTool = (
    mission: ComputerMission,
    tool: string,
    args: Record<string, unknown>,
    invocation: { readonly threadId: string; readonly providerSessionId: string },
  ): Effect.Effect<ComputerHostToolResult, ToolError | McpCapabilityUnavailableError> =>
    service
      .call({ missionId: mission.id, tool, args, owner: missionOwnerFor(invocation) })
      .pipe(Effect.mapError((error) => toolError("computer-unavailable", error.message)));

  let latest: ProviderObservation | undefined;
  const requireObservedTarget = (
    mission: ComputerMission,
    input: { readonly pid?: number | undefined; readonly windowId?: number | undefined },
  ) =>
    latest?.missionId === mission.id &&
    input.pid !== undefined &&
    input.windowId !== undefined &&
    latest.observation.target.pid === input.pid &&
    latest.observation.target.windowId === input.windowId
      ? Effect.void
      : Effect.fail(
          toolError(
            "observation-required",
            "Foreground input requires the exact pid and windowId from a fresh computer_window_state. Observe the target first.",
          ),
        );
  let sequence = 0;
  const consumedCaptures = new Set<string>();

  const resolveControl = (mission: ComputerMission, controlId: string) => {
    const match = /^o(\d+):(.+)$/.exec(controlId);
    const current = latest;
    if (
      match === null ||
      current === undefined ||
      current.missionId !== mission.id ||
      current.sequence !== Number(match[1])
    )
      return Effect.fail(
        toolError(
          "observation-stale",
          "That controlId is not from the latest observation. Call computer_window_state again.",
        ),
      );
    const element = current.observation.elements.find((entry) => entry.id === match[2]);
    const executable = current.observation.executables.get(match[2]!);
    if (element === undefined || executable === undefined)
      return Effect.fail(toolError("unknown-control", "No control with that id was observed."));
    return Effect.succeed({ observation: current.observation, element, executable });
  };

  /** The mission whose last input may or may not have been delivered. */
  let observeFirst: string | undefined;

  const observeWindow = (
    mission: ComputerMission,
    invocation: { readonly threadId: string; readonly providerSessionId: string },
    input: {
      readonly pid: number;
      readonly windowId: number;
      readonly includeScreenshot?: boolean | undefined;
      readonly lookCloser?: boolean | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const status = yield* service.status;
      // A screenshot is a separate capture; take it before the grounded
      // observation so it cannot outdate that observation's tokens.
      const screenshot =
        input.includeScreenshot === true
          ? yield* callTool(
              mission,
              "get_window_state",
              {
                pid: input.pid,
                window_id: input.windowId,
                include_screenshot: true,
                include_accessibility_tree: false,
              },
              invocation,
            ).pipe(Effect.map((result) => result.images[0]))
          : undefined;
      const observation = yield* observeGrounded({
        call: (tool, args) => callTool(mission, tool, args, invocation),
        target: { pid: input.pid, windowId: input.windowId },
        platform: cuaPlatform(status.host?.platform),
        visualAvailable: status.host?.capabilities.visualGrounding === true,
        mode: input.lookCloser === true ? "visual" : "auto",
      }).pipe(
        Effect.catchTag("GroundingError", (error) =>
          Effect.fail(toolError("observation-failed", error.reason)),
        ),
      );
      if (latest !== undefined && latest.missionId !== mission.id) consumedCaptures.clear();
      // Published in one step: this response's ids name exactly this
      // observation even if another observation is published meanwhile.
      sequence += 1;
      const published = sequence;
      latest = { missionId: mission.id, sequence: published, observation };
      if (observeFirst === mission.id) observeFirst = undefined;
      const report = observation.report;
      const limitation =
        report.fallback !== undefined && report.visual !== "parsed"
          ? report.visual === "unavailable"
            ? "This window does not expose its controls, and reading the screen is unavailable on this computer."
            : `Reading the screen failed (${report.visualCode ?? "unknown"}); observe again.`
          : undefined;
      return {
        windowTitle: observation.title ?? "",
        appName: observation.appName ?? "",
        ...(observation.text === undefined || observation.text.length === 0
          ? {}
          : { text: observation.text }),
        controls: observation.elements.map((element) => ({
          controlId: `o${published}:${element.id}`,
          source: element.source ?? "native",
          role: element.role,
          name: element.name,
          ...(element.value === undefined ? {} : { value: element.value }),
          x: element.bounds.x,
          y: element.bounds.y,
          width: element.bounds.width,
          height: element.bounds.height,
        })),
        ...(limitation === undefined ? {} : { limitation }),
        ...(screenshot === undefined ? {} : { screenshotBase64: screenshot.dataBase64 }),
      };
    });

  /**
   * Every provider input goes through here. It retires the observation the
   * input was chosen from, and after a dispatch whose delivery is unknown it
   * refuses further input until the provider observes again: an uncertain
   * action is never followed blindly, let alone repeated.
   */
  const act = <E, R>(
    mission: ComputerMission,
    dispatch: Effect.Effect<ComputerHostToolResult, E, R>,
    observeInvocation?: { readonly threadId: string; readonly providerSessionId: string },
  ): Effect.Effect<ComputerActionResult, E | ToolError, R> =>
    Effect.gen(function* () {
      const target =
        observeInvocation !== undefined && latest?.missionId === mission.id
          ? latest.observation.target
          : undefined;
      const result = yield* Effect.gen(function* () {
        if (observeFirst === mission.id)
          return yield* Effect.fail(
            toolError(
              "observe-first",
              "The last action's delivery is unknown. Call computer_window_state to see what happened before acting again.",
            ),
          );
        // A transport rejection can happen after dispatch. Keep the fence until a read succeeds.
        observeFirst = mission.id;
        const raw = yield* dispatch;
        if (raw.effect !== "dispatched-unknown") observeFirst = undefined;
        return toActionResult(raw);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            latest = undefined;
          }),
        ),
      );
      if (target === undefined || observeInvocation === undefined) return result;
      // The action's delivery classification stays honest; this is a separate read, never a retry.
      return yield* observeWindow(mission, observeInvocation, target).pipe(
        Effect.map((windowState) => ({ ...result, windowState })),
        Effect.catch((error) => Effect.succeed({ ...result, observationError: error.message })),
      );
    });

  const mustSucceed = (
    result: ComputerHostToolResult,
  ): Effect.Effect<ComputerHostToolResult, ToolError> =>
    result.isError
      ? Effect.fail(toolError(result.refusalCode ?? "driver-refused", result.text))
      : Effect.succeed(result);

  /**
   * The computer for this exact run: held already, or asked of the user and
   * granted while this call waits. A run never holds two missions.
   */
  const acquire = (goal: string) =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const shell = yield* orchestrator
        .getThreadShell(invocation.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      // Access is bound to the run that asks; its end withdraws the request
      // or hands the computer back.
      if (shell === null || shell.activeRunId === null) {
        return yield* Effect.fail(
          toolError("run-required", "Ask for the computer from inside a running turn."),
        );
      }
      const requester = {
        kind: "agent" as const,
        threadId: invocation.threadId,
        runId: shell.activeRunId,
        providerSessionId: invocation.providerSessionId,
        title: shell.title,
      };
      const finished = completedGoals.get(shell.activeRunId);
      if (finished !== undefined)
        return {
          status: "finished" as const,
          result: finished.result,
          requester,
        };
      if (yield* access.holds(requester)) {
        // The run holds the computer for its approved mission: a different
        // goal under the same grant needs a new mission and approval, so it
        // must not run silently. The caller reports this and ends the turn.
        const mission = yield* service.activeMission;
        if (
          mission !== undefined &&
          mission.owner.kind === "provider" &&
          mission.owner.threadId === invocation.threadId &&
          mission.owner.providerSessionId === invocation.providerSessionId &&
          cleanGoal(mission.goal) !== cleanGoal(goal)
        )
          return {
            status: "mismatch" as const,
            missionGoal: mission.goal,
            requester,
          };
        return { status: "granted" as const, requester };
      }
      const request = yield* access
        .request({ goal, requester })
        .pipe(Effect.mapError((error) => toolError("computer-unavailable", error.reason)));
      const grant = yield* access.awaitGrant(requester, request.id, BEGIN_WAIT);
      return { ...grant, requester };
    });

  return ComputerToolkit.of({
    computer_do: (input) =>
      Effect.gen(function* () {
        yield* requireCapability();
        if (!executor.wholeGoals)
          return {
            status: "unavailable",
            message:
              "This computer can't carry out whole goals. Use computer_begin and the step tools instead.",
          } satisfies ComputerDoResult;
        const grant = yield* acquire(input.goal);
        switch (grant.status) {
          case "finished":
            return grant.result;
          case "waiting":
            return {
              status: "waiting",
              message:
                "The user has not answered yet. Call computer_do again with the same goal to keep waiting.",
            } satisfies ComputerDoResult;
          case "declined":
            return { status: "declined", message: grant.message } satisfies ComputerDoResult;
          case "mismatch":
            return {
              status: "failed",
              message: `This run holds the computer for "${grant.missionGoal}". Call computer_end before requesting another goal.`,
            } satisfies ComputerDoResult;
          case "granted":
            break;
        }
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const mission = yield* service.activeMission;
        if (
          mission === undefined ||
          mission.owner.kind !== "provider" ||
          mission.owner.providerSessionId !== invocation.providerSessionId ||
          mission.owner.threadId !== invocation.threadId
        )
          return yield* Effect.fail(
            toolError(
              "mission-required",
              "This run holds no computer mission. Call computer_do again.",
            ),
          );
        return yield* observationLane.withPermit(
          Effect.gen(function* () {
            // The mission's grant is spent by its finished goal: a retry (same
            // or reworded) returns that result, and a different goal needs a
            // new mission after computer_end.
            const finishedForRun = completedGoals.get(grant.requester.runId);
            if (finishedForRun?.missionId === mission.id) {
              return finishedForRun.result;
            }
            if (cleanGoal(mission.goal) !== cleanGoal(input.goal)) {
              return {
                status: "failed" as const,
                message: `This mission was approved for "${mission.goal}". Call computer_end before requesting another goal.`,
              };
            }
            let finished: Parameters<NonNullable<CirceComputerGoal["onFinished"]>>[0] | undefined;
            // One lane with the step tools: their controlIds are retired by
            // whatever Circe does in the window.
            const result = yield* executor
              .runInMission(mission, {
                goal: input.goal,
                // A stop from the user ends the grant or the mission; either one
                // stops the goal before its next action.
                stopped: Effect.gen(function* () {
                  const current = yield* service.activeMission;
                  if (current?.id !== mission.id) return true;
                  return !(yield* access.holds(grant.requester));
                }),
                ...(input.plan === undefined ? {} : { plan: input.plan }),
                ...(input.text === undefined ? {} : { typeText: input.text }),
                onFinished: (outcome) => {
                  finished = outcome;
                },
              })
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    latest = undefined;
                  }),
                ),
              );
            const status: ComputerDoResult["status"] =
              finished?.status === "unverified" || finished?.status === "uncertain"
                ? finished.status
                : result.status === "done"
                  ? "done"
                  : result.status === "cancelled"
                    ? "stopped"
                    : result.status === "needs-input"
                      ? "needs-input"
                      : "failed";
            const response = {
              status,
              message: result.message,
              ...(finished === undefined
                ? {}
                : {
                    actions: finished.actions,
                    timings: {
                      totalMs: finished.metrics.totalMs,
                      plannerCalls: finished.metrics.planner.calls,
                      plannerMs: finished.metrics.planner.ms,
                      jevCalls: finished.metrics.jev.calls,
                      jevMs: finished.metrics.jev.ms,
                      actionMs: finished.metrics.act.ms + finished.metrics.launch.ms,
                      verifyMs: finished.metrics.verify.ms,
                    },
                  }),
            } satisfies ComputerDoResult;
            rememberCompleted(grant.requester.runId, mission.id, response);
            yield* access.release(invocation.providerSessionId);
            return response;
          }),
        );
      }),

    computer_status: () =>
      Effect.gen(function* () {
        yield* requireCapability();
        const status = yield* service.status;
        return {
          available: status.available,
          ...(status.host === undefined
            ? {}
            : {
                platform: status.host.platform,
                runtime: status.host.runtime,
                capabilities: {
                  observe: status.host.capabilities.observe,
                  capture: status.host.capabilities.capture,
                  pointer: status.host.capabilities.pointer,
                  keyboard: status.host.capabilities.keyboard,
                  windows: status.host.capabilities.windows,
                  nativeGrounding: status.host.capabilities.nativeGrounding,
                  visualGrounding: status.host.capabilities.visualGrounding,
                },
              }),
          ...(status.host?.reason === undefined ? {} : { reason: status.host.reason }),
          missionActive: status.activeMission !== undefined,
        };
      }),

    computer_begin: (input) =>
      Effect.gen(function* () {
        yield* requireCapability();
        const grant = yield* acquire(input.goal);
        switch (grant.status) {
          case "finished":
            return {
              status: "declined" as const,
              message: `This run already finished a goal with status ${grant.result.status}: ${grant.result.message} Report it instead of requesting another goal in the same run.`,
            };
          case "granted":
            return {
              status: "granted" as const,
              message: "You hold the computer. Call computer_end when you are done.",
            };
          case "mismatch":
            return {
              status: "declined" as const,
              message: `This run holds the computer for "${grant.missionGoal}". Call computer_end before requesting another goal.`,
            };
          case "waiting":
            return {
              status: "waiting" as const,
              message:
                "The user has not answered yet. Call computer_begin again with the same goal to keep waiting.",
            };
          case "declined":
            return { status: "declined" as const, message: grant.message };
        }
      }),

    computer_end: () =>
      Effect.gen(function* () {
        yield* requireCapability();
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const held = (yield* access.state).active;
        yield* access.release(invocation.providerSessionId);
        return {
          released:
            held?.requester.kind === "agent" &&
            held.requester.providerSessionId === invocation.providerSessionId,
        };
      }),

    computer_list_apps: (input) =>
      withMission((mission, current, invocation) =>
        Effect.gen(function* () {
          const result = yield* callTool(mission, "list_apps", {}, invocation).pipe(
            Effect.flatMap(mustSucceed),
          );
          const status = yield* current.status;
          const query = input.query?.toLowerCase();
          return {
            apps: readApps(result.structured)
              .filter(
                (app) =>
                  status.host?.platform !== "linux" ||
                  app.kind === "desktop" ||
                  !!app.launch_path ||
                  (app.windows?.length ?? 0) > 0,
              )
              .filter(
                (app) =>
                  query === undefined ||
                  [app.name, app.bundle_id, app.launch_path].some((value) =>
                    value?.toLowerCase().includes(query),
                  ),
              )
              .map((app) => ({
                name: app.name,
                ...(app.pid > 0 ? { pid: app.pid } : {}),
                running: app.running,
                ...(app.active === undefined ? {} : { active: app.active }),
                ...(app.launch_path ? { launchPath: app.launch_path } : {}),
                ...(app.bundle_id ? { bundleId: app.bundle_id } : {}),
              })),
          };
        }),
      ),

    computer_list_windows: (input) =>
      withMission((mission, _service, invocation) =>
        callTool(
          mission,
          "list_windows",
          {
            ...(input.pid === undefined ? {} : { pid: input.pid }),
            ...(input.all === true ? {} : { on_screen_only: true }),
          },
          invocation,
        ).pipe(
          Effect.flatMap(mustSucceed),
          Effect.map((result) => ({
            windows: readWindows(result.structured).map(providerWindow),
          })),
        ),
      ),

    computer_window_state: (input) =>
      withMission((mission, _current, invocation) => observeWindow(mission, invocation, input)),

    computer_click: (input) =>
      withMission((mission, _service, invocation) =>
        act(
          mission,
          Effect.gen(function* () {
            const control = yield* resolveControl(mission, input.controlId);
            if (control.executable.kind === "visual") {
              if (consumedCaptures.has(control.executable.captureId))
                return yield* Effect.fail(
                  toolError(
                    "capture-consumed",
                    "That screen capture already authorized an action. Call computer_window_state again.",
                  ),
                );
              consumedCaptures.add(control.executable.captureId);
            }
            const result = yield* callTool(
              mission,
              "click",
              {
                ...clickArguments(control.observation.target, control.executable),
                ...(input.button === undefined ? {} : { button: input.button }),
                ...(input.count === undefined ? {} : { count: input.count }),
              },
              invocation,
            );
            return result;
          }),
          invocation,
        ),
      ),

    computer_type: (input) =>
      withMission((mission, _service, invocation) =>
        Effect.gen(function* () {
          if (input.controlId === undefined) {
            if (input.delivery !== "foreground")
              return yield* Effect.fail(
                toolError(
                  "typing-target-required",
                  "Use the text field's controlId from computer_window_state to type in the background. For a drawn field, click it, observe again, then specify delivery foreground with exact pid and windowId.",
                ),
              );
            yield* requireObservedTarget(mission, input);
          }
          return yield* act(
            mission,
            Effect.gen(function* () {
              const control =
                input.controlId === undefined
                  ? undefined
                  : yield* resolveControl(mission, input.controlId);
              if (control !== undefined && control.executable.kind !== "native")
                return yield* Effect.fail(
                  toolError(
                    "unsupported-target",
                    "Text read from the screen cannot receive typing by controlId. Click it, observe again, then type with delivery foreground and the exact observed pid and windowId.",
                  ),
                );
              const result = yield* callTool(
                mission,
                "type_text",
                {
                  text: input.text,
                  ...(control?.executable.kind === "native"
                    ? {
                        element_token: control.executable.token,
                        pid: control.observation.target.pid,
                        window_id: control.observation.target.windowId,
                      }
                    : {
                        ...(input.pid === undefined ? {} : { pid: input.pid }),
                        ...(input.windowId === undefined ? {} : { window_id: input.windowId }),
                      }),
                  delivery_mode: input.delivery ?? "background",
                },
                invocation,
              );
              return result;
            }),
            invocation,
          );
        }),
      ),

    computer_key: (input) =>
      withMission((mission, _service, invocation) =>
        Effect.gen(function* () {
          if (input.delivery === "foreground") yield* requireObservedTarget(mission, input);
          return yield* act(
            mission,
            callTool(
              mission,
              input.modifiers !== undefined && input.modifiers.length > 0 ? "hotkey" : "press_key",
              input.modifiers !== undefined && input.modifiers.length > 0
                ? {
                    keys: [...input.modifiers, input.key],
                    ...(input.pid === undefined ? {} : { pid: input.pid }),
                    ...(input.windowId === undefined ? {} : { window_id: input.windowId }),
                    delivery_mode: input.delivery ?? "background",
                  }
                : {
                    key: input.key,
                    ...(input.pid === undefined ? {} : { pid: input.pid }),
                    ...(input.windowId === undefined ? {} : { window_id: input.windowId }),
                    delivery_mode: input.delivery ?? "background",
                  },
              invocation,
            ),
          );
        }),
      ),

    computer_scroll: (input) =>
      withMission((mission, _service, invocation) =>
        act(
          mission,
          callTool(
            mission,
            "scroll",
            {
              direction: input.direction,
              ...(input.amount === undefined ? {} : { amount: input.amount }),
              ...(input.pid === undefined ? {} : { pid: input.pid }),
              ...(input.windowId === undefined ? {} : { window_id: input.windowId }),
              delivery_mode: "background",
            },
            invocation,
          ),
        ),
      ),

    computer_launch_app: (input) =>
      withMission((mission, _service, invocation) =>
        Effect.gen(function* () {
          let launched: ComputerHostToolResult | undefined;
          const action = yield* act(
            mission,
            callTool(
              mission,
              "launch_app",
              {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.bundleId === undefined ? {} : { bundle_id: input.bundleId }),
                ...(input.launchPath === undefined ? {} : { launch_path: input.launchPath }),
                ...(input.urls === undefined || input.urls.length === 0
                  ? {}
                  : { urls: input.urls }),
              },
              invocation,
            ).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  launched = result;
                }),
              ),
            ),
          );
          const decoded = launchPid(launched?.structured);
          const pid = decoded._tag === "Some" ? decoded.value.pid : undefined;
          return {
            ...action,
            ...(pid == null ? {} : { pid }),
            windows: readWindows(launched?.structured).map(providerWindow),
          };
        }),
      ),
  });
});

export const ComputerToolkitHandlersLive = ComputerToolkit.toLayer(make);
