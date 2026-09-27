import { McpCapabilityUnavailableError, type ComputerHostToolResult } from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ComputerService,
  type ComputerMission,
  type ComputerMissionOwner,
  type ComputerServiceShape,
} from "../../../computer/ComputerService.ts";
import {
  groundElements,
  readApps,
  readWindowState,
  readWindows,
} from "../../../computer/driverSchemas.ts";
import { CirceComputerAccess } from "../../../circe/Services/CirceComputerAccess.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputerToolkit } from "./tools.ts";

const TOOL_ERROR_SCHEMA = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});
type ToolError = typeof TOOL_ERROR_SCHEMA.Type;

const toolError = (code: string, message: string): ToolError => ({ code, message });

/** How long one computer_begin call waits on the user; below the providers' tool-call timeouts. */
const BEGIN_WAIT = "45 seconds";

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
const toActionResult = (result: ComputerHostToolResult) => ({
  ok: !result.isError && result.effect === "verified",
  effect: result.effect,
  text: result.text,
  ...(result.refusalCode === undefined ? {} : { refusalCode: result.refusalCode }),
});

export const make = Effect.gen(function* () {
  const service = yield* ComputerService;
  const access = yield* CirceComputerAccess;
  const orchestrator = yield* OrchestratorV2;
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
      const shell = yield* orchestrator
        .getThreadShell(invocation.threadId)
        .pipe(Effect.orElseSucceed(() => null));
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
    });

  const callTool = (
    mission: ComputerMission,
    tool: string,
    args: Record<string, unknown>,
    invocation: { readonly threadId: string; readonly providerSessionId: string },
  ): Effect.Effect<ComputerHostToolResult, ToolError | McpCapabilityUnavailableError> =>
    service
      .call({ missionId: mission.id, tool, args, owner: missionOwnerFor(invocation) })
      .pipe(Effect.mapError((error) => toolError("computer-unavailable", error.message)));

  const mustSucceed = (
    result: ComputerHostToolResult,
  ): Effect.Effect<ComputerHostToolResult, ToolError> =>
    result.isError
      ? Effect.fail(toolError(result.refusalCode ?? "driver-refused", result.text))
      : Effect.succeed(result);

  return ComputerToolkit.of({
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
                capabilities: status.host.capabilities,
              }),
          ...(status.host?.reason === undefined ? {} : { reason: status.host.reason }),
          missionActive: status.activeMission !== undefined,
        };
      }),

    computer_begin: (input) =>
      Effect.gen(function* () {
        yield* requireCapability();
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
        const request = yield* access
          .request({ goal: input.goal, requester })
          .pipe(Effect.mapError((error) => toolError("computer-unavailable", error.reason)));
        const grant = yield* access.awaitGrant(requester, request.id, BEGIN_WAIT);
        switch (grant.status) {
          case "granted":
            return {
              status: "granted" as const,
              message: "You hold the computer. Call computer_end when you are done.",
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

    computer_list_apps: () =>
      withMission((mission, current, invocation) =>
        callTool(mission, "list_apps", {}, invocation).pipe(
          Effect.flatMap(mustSucceed),
          Effect.map((result) => ({
            apps: readApps(result.structured)
              .filter((app) => app.pid > 0)
              .map((app) => ({
                name: app.name,
                ...(app.pid > 0 ? { pid: app.pid } : {}),
                running: app.running,
                ...(app.active === undefined ? {} : { active: app.active }),
              })),
          })),
          Effect.tap(() => Effect.succeed(current)),
        ),
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
            windows: readWindows(result.structured).map((window) => ({
              windowId: Math.trunc(window.window_id),
              pid: window.pid,
              appName: window.app_name,
              title: window.title,
              onScreen: window.is_on_screen !== false,
            })),
          })),
        ),
      ),

    computer_window_state: (input) =>
      withMission((mission, _service, invocation) =>
        callTool(
          mission,
          "get_window_state",
          {
            pid: input.pid,
            window_id: input.windowId,
            include_screenshot: input.includeScreenshot === true,
          },
          invocation,
        ).pipe(
          Effect.flatMap(mustSucceed),
          Effect.map((result) => {
            const state = readWindowState(result.structured);
            const image = input.includeScreenshot === true ? result.images[0] : undefined;
            return {
              windowTitle: state?.window_title ?? "",
              appName: state?.app_name ?? "",
              elements: (state === undefined ? [] : groundElements(state)).map((element) => ({
                token: element.token,
                role: element.role,
                name: element.name,
                ...(element.value === undefined ? {} : { value: element.value }),
                x: element.bounds.x,
                y: element.bounds.y,
                width: element.bounds.width,
                height: element.bounds.height,
              })),
              ...(image === undefined ? {} : { screenshotBase64: image.dataBase64 }),
            };
          }),
        ),
      ),

    computer_click: (input) =>
      withMission((mission, _service, invocation) =>
        callTool(
          mission,
          "click",
          {
            pid: input.pid,
            window_id: input.windowId,
            ...(input.elementToken !== undefined
              ? { element_token: input.elementToken }
              : input.x !== undefined && input.y !== undefined
                ? { x: input.x, y: input.y }
                : {}),
            ...(input.button === undefined ? {} : { button: input.button }),
            ...(input.count === undefined ? {} : { count: input.count }),
            delivery_mode: "background",
          },
          invocation,
        ).pipe(Effect.map(toActionResult)),
      ),

    computer_type: (input) =>
      withMission((mission, _service, invocation) =>
        callTool(
          mission,
          "type_text",
          {
            text: input.text,
            ...(input.elementToken === undefined ? {} : { element_token: input.elementToken }),
            ...(input.pid === undefined ? {} : { pid: input.pid }),
            ...(input.windowId === undefined ? {} : { window_id: input.windowId }),
            delivery_mode: "background",
          },
          invocation,
        ).pipe(Effect.map(toActionResult)),
      ),

    computer_key: (input) =>
      withMission((mission, _service, invocation) =>
        callTool(
          mission,
          input.modifiers !== undefined && input.modifiers.length > 0 ? "hotkey" : "press_key",
          input.modifiers !== undefined && input.modifiers.length > 0
            ? {
                keys: [...input.modifiers, input.key],
                ...(input.pid === undefined ? {} : { pid: input.pid }),
                ...(input.windowId === undefined ? {} : { window_id: input.windowId }),
                delivery_mode: "background",
              }
            : {
                key: input.key,
                ...(input.pid === undefined ? {} : { pid: input.pid }),
                ...(input.windowId === undefined ? {} : { window_id: input.windowId }),
                delivery_mode: "background",
              },
          invocation,
        ).pipe(Effect.map(toActionResult)),
      ),

    computer_scroll: (input) =>
      withMission((mission, _service, invocation) =>
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
        ).pipe(Effect.map(toActionResult)),
      ),

    computer_launch_app: (input) =>
      withMission((mission, _service, invocation) =>
        callTool(
          mission,
          "launch_app",
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.bundleId === undefined ? {} : { bundle_id: input.bundleId }),
            ...(input.launchPath === undefined ? {} : { launch_path: input.launchPath }),
            ...(input.urls === undefined || input.urls.length === 0 ? {} : { urls: input.urls }),
          },
          invocation,
        ).pipe(Effect.map(toActionResult)),
      ),
  });
});

export const ComputerToolkitHandlersLive = ComputerToolkit.toLayer(make);
