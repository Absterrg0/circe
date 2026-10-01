import { describe, expect, it } from "@effect/vitest";
import { CirceComputerUse } from "../../../circe/Services/CirceComputerUse.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { McpServer, McpSchema } from "effect/unstable/ai";

import type { ComputerHostToolResult } from "@circe/contracts";
import { EnvironmentId, ThreadId } from "@circe/contracts";
import { ProviderInstanceId } from "@circe/contracts";

import {
  ComputerMissionError,
  ComputerService,
  type ComputerMission,
} from "../../../computer/ComputerService.ts";
import { CirceComputerAccess } from "../../../circe/Services/CirceComputerAccess.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { make } from "./handlers.ts";
import { ComputerToolkit } from "./tools.ts";

const mission: ComputerMission = {
  id: "mission-1",
  goal: "open the calculator",
  source: "voice",
  owner: { kind: "provider", threadId: "thread-1", providerSessionId: "session-1" },
  startedAtMs: 0,
};

const ok = (structured?: unknown): ComputerHostToolResult => ({
  isError: false,
  degraded: false,
  effect: "verified",
  text: "ok",
  ...(structured === undefined ? {} : { structured }),
  images: [],
});

const withToolkit = <A, E, R>(
  input: {
    readonly mission: ComputerMission | undefined;
    readonly capabilities?: ReadonlySet<string>;
    readonly calls?: Array<{ tool: string; args: Record<string, unknown> }>;
    readonly providerSessionId?: string;
    readonly toolEffects?: Readonly<
      Record<string, "verified" | "dispatched-unknown" | "refused" | "transport-unknown">
    >;
    /** Serve a chrome-only window whose controls only perception can read. */
    readonly visual?: boolean;
    /** The host's visual-grounding capability; follows `visual` by default. */
    readonly perception?: boolean;
    readonly beforeCall?: (tool: string) => Effect.Effect<void, ComputerMissionError>;
    readonly results?: Readonly<Record<string, ComputerHostToolResult>>;
  },
  run: (handlers: Effect.Success<typeof make>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const handlers = yield* make;
    return yield* run(handlers);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        // The step tools under test; whole goals have their own tests.
        Layer.mock(CirceComputerUse)({ wholeGoals: false }),
        Layer.mock(CirceComputerAccess)({ controllable: true, holds: () => Effect.succeed(true) }),
        Layer.mock(OrchestratorV2)({ getThreadShell: () => Effect.succeed(null) }),
        Layer.mock(ComputerService)({
          status: Effect.succeed({
            available: true,
            host: {
              available: true,
              platform: "linux" as const,
              runtime: "ready" as const,
              capabilities: {
                observe: true,
                capture: true,
                pointer: true,
                keyboard: true,
                windows: true,
                browser: false,
                nativeGrounding: true,
                visualGrounding: input.perception ?? input.visual === true,
              },
            },
            activeMission: input.mission,
          }),
          activeMission: Effect.succeed(input.mission),
          call: (call) =>
            Effect.gen(function* () {
              if (input.beforeCall !== undefined) yield* input.beforeCall(call.tool);
              return yield* Effect.sync(() => {
                input.calls?.push({
                  tool: call.tool,
                  args: (call.args ?? {}) as Record<string, unknown>,
                });
                if (input.results?.[call.tool] !== undefined) return input.results[call.tool]!;
                const forcedEffect = input.toolEffects?.[call.tool];
                if (forcedEffect !== undefined)
                  return {
                    isError: forcedEffect === "refused" || forcedEffect === "transport-unknown",
                    degraded: false,
                    effect:
                      forcedEffect === "transport-unknown" ? "dispatched-unknown" : forcedEffect,
                    text: `${call.tool} ${forcedEffect}`,
                    images: [],
                  };
                if (call.tool === "list_windows")
                  return ok({
                    windows: [
                      {
                        window_id: 12,
                        pid: 99,
                        app_name: "Calculator",
                        title: "Calculator",
                        z_index: 1,
                        is_on_screen: true,
                      },
                    ],
                  });
                const args = (call.args ?? {}) as Record<string, unknown>;
                if (call.tool === "get_window_state" && input.visual === true)
                  return ok({
                    pid: 99,
                    window_id: 12,
                    window_title: "Canvas",
                    app_name: "Canvas",
                    snapshot_id: "s00000002",
                    ...(args.include_screenshot === true ? { capture_id: "cap-9" } : {}),
                    screenshot_width: 200,
                    screenshot_height: 100,
                    elements_complete: false,
                    elements: [{ element_index: 0, element_token: "s00000002:0", role: "window" }],
                  });
                if (call.tool === "parse_visual_regions")
                  return ok({
                    schema: "cua.visual_regions_v1",
                    capture: {
                      capture_id: args.capture_id,
                      source: { kind: "window", pid: 99, window_id: 12 },
                      screenshot: {
                        mime_type: "image/png",
                        reference: "r",
                        width: 200,
                        height: 100,
                      },
                      action_coordinate_space: { kind: "screenshot_pixels" },
                    },
                    regions: [
                      {
                        id: "text-1",
                        kind: "text",
                        text: "Send",
                        confidence: 0.9,
                        interactive: false,
                        bounds: { x: 10, y: 20, width: 40, height: 10 },
                      },
                    ],
                  });
                if (call.tool === "get_window_state")
                  return ok({
                    window_title: "Calculator",
                    app_name: "Calculator",
                    snapshot_id: "s00000001",
                    elements: [
                      {
                        element_token: "s00000001:0",
                        role: "push button",
                        label: "5",
                        frame: { x: 10, y: 20, w: 30, h: 30 },
                        enabled: true,
                      },
                    ],
                  });
                return ok();
              });
            }),
        }),
        Layer.succeed(McpInvocationContext, {
          environmentId: EnvironmentId.make("env-1"),
          threadId: ThreadId.make("thread-1"),
          providerSessionId: input.providerSessionId ?? "session-1",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: (input.capabilities ?? new Set(["computer-use"])) as ReadonlySet<
            "computer-use" | "preview" | "orchestration" | "worktree" | "device" | "pull-requests"
          >,
          issuedAt: 0,
        }),
      ),
    ),
  );

describe("computer toolkit handlers", () => {
  it.effect("tells the provider how to recover from a stale control through MCP", () =>
    withToolkit({ mission }, (handlers) =>
      Effect.gen(function* () {
        yield* McpServer.registerToolkit(ComputerToolkit).pipe(
          Effect.provide(ComputerToolkit.toLayer(Effect.succeed(handlers))),
        );
        const server = yield* McpServer.McpServer;
        const result = yield* server
          .callTool({ name: "computer_click", arguments: { controlId: "expired" } })
          .pipe(
            Effect.provideService(
              McpSchema.McpServerClient,
              McpSchema.McpServerClient.of({
                clientId: 1,
                clientCapabilities: {},
                clientInfo: { name: "computer-test", version: "1" },
                protocolVersion: "2025-06-18",
                initializePayload: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "computer-test", version: "1" },
                },
                getClient: Effect.die("unused"),
              }),
            ),
          );
        expect(result.isError).toBe(true);
        expect(result.content).toMatchObject([
          { type: "text", text: expect.stringContaining("Call computer_window_state again") },
        ]);
      }).pipe(Effect.provide(McpServer.McpServer.layer)),
    ),
  );

  it.effect(
    "requires a text control before background typing without consuming its observation",
    () => {
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      return withToolkit({ mission, calls }, (handlers) =>
        Effect.gen(function* () {
          const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
          const error = yield* Effect.flip(
            handlers.computer_type({ pid: 99, windowId: 12, text: "50+3" }),
          );
          expect(error).toMatchObject({ code: "typing-target-required" });
          expect(calls.some((call) => call.tool === "type_text")).toBe(false);
          yield* handlers.computer_type({ controlId: state.controls[0]!.controlId, text: "50+3" });
          expect(calls.findLast((call) => call.tool === "type_text")).toMatchObject({
            tool: "type_text",
            args: { element_token: "s00000001:0", text: "50+3", delivery_mode: "background" },
          });
        }),
      );
    },
  );
  it.effect("requires a fresh exact window before foreground input", () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    return withToolkit({ mission, calls }, (handlers) =>
      Effect.gen(function* () {
        const input = { pid: 99, windowId: 12, delivery: "foreground" as const };
        const beforeObservation = yield* Effect.flip(
          handlers.computer_type({ ...input, text: "50+3" }),
        );
        expect(beforeObservation).toMatchObject({ code: "observation-required" });
        yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
        const wrongWindow = yield* Effect.flip(
          handlers.computer_key({ ...input, windowId: 13, key: "Return" }),
        );
        expect(wrongWindow).toMatchObject({ code: "observation-required" });
        expect(calls.some((call) => call.tool === "type_text" || call.tool === "press_key")).toBe(
          false,
        );
        yield* handlers.computer_type({ ...input, text: "50+3" });
        expect(calls.findLast((call) => call.tool === "type_text")).toMatchObject({
          tool: "type_text",
          args: { pid: 99, window_id: 12, text: "50+3", delivery_mode: "foreground" },
        });
        yield* handlers.computer_key({ ...input, key: "Return" });
        const consumed = yield* Effect.flip(handlers.computer_key({ ...input, key: "Return" }));
        expect(consumed).toMatchObject({ code: "observation-required" });
        expect(calls.at(-1)).toMatchObject({
          tool: "press_key",
          args: { pid: 99, window_id: 12, key: "Return", delivery_mode: "foreground" },
        });
      }),
    );
  });

  it.effect("returns the launched window identity so a provider can observe it directly", () =>
    withToolkit(
      {
        mission,
        results: {
          launch_app: {
            ...ok({
              pid: 99,
              windows: [
                {
                  window_id: 12,
                  pid: 99,
                  app_name: "Calculator",
                  title: "Calculator",
                  is_on_screen: true,
                },
              ],
            }),
            effect: "dispatched-unknown",
          },
        },
      },
      (handlers) =>
        Effect.gen(function* () {
          const launched = yield* handlers.computer_launch_app({ name: "Calculator" });
          expect(launched).toMatchObject({ pid: 99, windows: [{ pid: 99, windowId: 12 }] });
        }),
    ),
  );

  it.effect(
    "lists launchable desktop apps without hiding stopped apps or dumping kernel processes",
    () =>
      withToolkit(
        {
          mission,
          results: {
            list_apps: ok({
              apps: [
                {
                  name: "systemd",
                  pid: 1,
                  running: true,
                  kind: null,
                  launch_path: null,
                  bundle_id: null,
                  windows: [],
                },
                {
                  name: "Calculator",
                  pid: 0,
                  running: false,
                  kind: "desktop",
                  launch_path: "gnome-calculator",
                  bundle_id: "org.gnome.Calculator",
                },
                {
                  name: "Editor",
                  pid: 99,
                  running: true,
                  windows: [{ window_id: 12, pid: 99, app_name: "Editor", title: "Untitled" }],
                },
              ],
            }),
          },
        },
        (handlers) =>
          Effect.gen(function* () {
            const result = yield* handlers.computer_list_apps({});
            expect(result.apps.map((app) => app.name)).toEqual(["Calculator", "Editor"]);
            expect(result.apps[0]).toMatchObject({
              launchPath: "gnome-calculator",
              running: false,
            });
          }),
      ),
  );

  it.effect("uses one native observation for at most one concurrent input", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
      yield* withToolkit(
        {
          mission,
          calls,
          beforeCall: (tool) =>
            tool === "click"
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        },
        (handlers) =>
          Effect.gen(function* () {
            const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
            const click = () =>
              handlers.computer_click({ controlId: state.controls[0]!.controlId });
            const first = yield* click().pipe(Effect.forkChild);
            yield* Deferred.await(started);
            const second = yield* click().pipe(Effect.result, Effect.forkChild);
            yield* Effect.yieldNow;
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(first);
            const result = yield* Fiber.join(second);
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { code: "observation-stale" },
            });
            expect(calls.filter((call) => call.tool === "click")).toHaveLength(1);
          }),
      );
    }),
  );

  it.effect("requires a new observation after a mutation transport rejects", () =>
    withToolkit(
      {
        mission,
        beforeCall: (tool) =>
          tool === "click"
            ? Effect.fail(
                new ComputerMissionError({ reason: "host request timed out after dispatch" }),
              )
            : Effect.void,
      },
      (handlers) =>
        Effect.gen(function* () {
          const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
          yield* handlers
            .computer_click({ controlId: state.controls[0]!.controlId })
            .pipe(Effect.result);
          const blocked = yield* Effect.flip(handlers.computer_key({ key: "Return" }));
          expect(blocked).toMatchObject({ code: "observe-first" });
          yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
          yield* handlers.computer_key({ key: "Return" });
        }),
    ),
  );

  it.effect("reports status and the active mission", () =>
    withToolkit({ mission: undefined }, (handlers) =>
      Effect.gen(function* () {
        const status = yield* handlers.computer_status();
        expect(status.available).toBe(true);
        expect(status.missionActive).toBe(false);
      }),
    ),
  );

  it.effect("refuses actions until the user starts a mission", () =>
    withToolkit({ mission: undefined }, (handlers) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(handlers.computer_list_windows({}));
        expect(error).toMatchObject({ code: "mission-required" });
      }),
    ),
  );

  it.effect("lists windows and grounds elements inside an active mission", () =>
    withToolkit({ mission }, (handlers) =>
      Effect.gen(function* () {
        const windows = yield* handlers.computer_list_windows({});
        expect(windows.windows).toHaveLength(1);
        expect(windows.windows[0]).toMatchObject({ windowId: 12, appName: "Calculator" });

        const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
        expect(state.controls).toHaveLength(1);
        expect(state.controls[0]).toMatchObject({
          controlId: "o1:s00000001:0",
          source: "native",
          name: "5",
          x: 10,
          y: 20,
        });
      }),
    ),
  );

  it.effect("clicks an observed native control by its token", () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    return withToolkit({ mission, calls }, (handlers) =>
      Effect.gen(function* () {
        const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
        const result = yield* handlers.computer_click({ controlId: state.controls[0]!.controlId });
        expect(result.ok).toBe(true);
        expect(calls.findLast((call) => call.tool === "click")).toMatchObject({
          tool: "click",
          args: { element_token: "s00000001:0", pid: 99, window_id: 12 },
        });
        expect(calls.some((call) => call.tool === "parse_visual_regions")).toBe(false);
      }),
    );
  });

  it.effect("clicks a visual control only through its capture, once", () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    return withToolkit({ mission, calls, visual: true }, (handlers) =>
      Effect.gen(function* () {
        const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
        const send = state.controls.find((control) => control.name === "Send")!;
        expect(send.source).toBe("visual");
        yield* handlers.computer_click({ controlId: send.controlId });
        expect(calls.findLast((call) => call.tool === "click")).toMatchObject({
          tool: "click",
          args: { pid: 99, window_id: 12, x: 30, y: 25, capture_id: "cap-9" },
        });
        // The action retired the observation: its ids cannot act again.
        const stale = yield* Effect.flip(handlers.computer_click({ controlId: send.controlId }));
        expect(stale).toMatchObject({ code: "observation-stale" });
        expect(calls.filter((call) => call.tool === "click")).toHaveLength(1);
      }),
    );
  });

  it.effect("refuses to type into a control read from the screen", () =>
    withToolkit({ mission, visual: true }, (handlers) =>
      Effect.gen(function* () {
        const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
        const send = state.controls.find((control) => control.name === "Send")!;
        const error = yield* Effect.flip(
          handlers.computer_type({ text: "hi", controlId: send.controlId }),
        );
        expect(error).toMatchObject({ code: "unsupported-target" });
      }),
    ),
  );

  it.effect("reports a visual-only window without perception as a limitation", () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    return withToolkit({ mission, calls, visual: true, perception: false }, (handlers) =>
      Effect.gen(function* () {
        const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
        expect(state.limitation).toMatch(/reading the screen is unavailable/);
        expect(state.controls.every((control) => control.source === "native")).toBe(true);
        expect(calls.some((call) => call.tool === "parse_visual_regions")).toBe(false);
      }),
    );
  });

  it.effect("requires the computer-use capability", () =>
    withToolkit({ mission, capabilities: new Set() }, (handlers) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(handlers.computer_list_windows({}));
        expect("_tag" in error && error._tag).toBe("McpCapabilityUnavailableError");
      }),
    ),
  );

  it.effect("refuses a mission owned by a different provider session", () =>
    withToolkit({ mission, providerSessionId: "session-b" }, (handlers) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(handlers.computer_click({ controlId: "o1:s00000001:0" }));
        expect(error).toMatchObject({ code: "mission-owner-mismatch" });
      }),
    ),
  );

  it.effect("returns fresh controls after an input without another provider round trip", () =>
    withToolkit({ mission, toolEffects: { click: "dispatched-unknown" } }, (handlers) =>
      Effect.gen(function* () {
        const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
        const result = yield* handlers.computer_click({ controlId: state.controls[0]!.controlId });
        expect(result).toMatchObject({
          effect: "dispatched-unknown",
          windowState: { controls: [{ controlId: "o2:s00000001:0" }] },
        });
      }),
    ),
  );

  it.effect("reports an uncertain action as ok=false with its effect", () =>
    withToolkit({ mission, toolEffects: { click: "dispatched-unknown" } }, (handlers) =>
      Effect.gen(function* () {
        const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
        const result = yield* handlers.computer_click({ controlId: state.controls[0]!.controlId });
        expect(result.ok).toBe(false);
        expect(result.effect).toBe("dispatched-unknown");
      }),
    ),
  );

  it.effect("preserves uncertain delivery when the automatic observation fails", () => {
    let failRead = false;
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    return withToolkit(
      {
        mission,
        calls,
        toolEffects: { click: "transport-unknown" },
        beforeCall: (tool) =>
          tool === "click"
            ? Effect.sync(() => {
                failRead = true;
              })
            : tool === "get_window_state" && failRead
              ? Effect.fail(new ComputerMissionError({ reason: "window read unavailable" }))
              : Effect.void,
      },
      (handlers) =>
        Effect.gen(function* () {
          const state = yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
          const result = yield* handlers.computer_click({
            controlId: state.controls[0]!.controlId,
          });
          expect(result).toMatchObject({
            ok: false,
            effect: "dispatched-unknown",
            observationError: expect.stringContaining("window read unavailable"),
          });
          const blocked = yield* Effect.flip(handlers.computer_key({ key: "Return" }));
          expect(blocked).toMatchObject({ code: "observe-first" });
          expect(calls.filter((call) => call.tool === "press_key")).toHaveLength(0);
          failRead = false;
          yield* handlers.computer_window_state({ pid: 99, windowId: 12 });
          yield* handlers.computer_key({ key: "Return" });
          expect(calls.filter((call) => call.tool === "press_key")).toHaveLength(1);
        }),
    );
  });

  it.effect("surfaces a service mission error as a tool failure", () => {
    const failing = Layer.mock(ComputerService)({
      activeMission: Effect.succeed(mission),
      call: () => Effect.fail(new ComputerMissionError({ reason: "host went away" })),
    });
    return Effect.gen(function* () {
      const handlers = yield* make;
      const error = yield* Effect.flip(handlers.computer_list_apps({}));
      expect(error).toMatchObject({ code: "computer-unavailable", message: "host went away" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          failing,
          Layer.mock(CirceComputerUse)({ wholeGoals: false }),
          Layer.mock(CirceComputerAccess)({
            controllable: true,
            holds: () => Effect.succeed(true),
          }),
          Layer.mock(OrchestratorV2)({ getThreadShell: () => Effect.succeed(null) }),
          Layer.succeed(McpInvocationContext, {
            environmentId: EnvironmentId.make("env-1"),
            threadId: ThreadId.make("thread-1"),
            providerSessionId: "session-1",
            providerInstanceId: ProviderInstanceId.make("codex"),
            capabilities: new Set(["computer-use"]) as ReadonlySet<"computer-use">,
            issuedAt: 0,
          }),
        ),
      ),
    );
  });
});
