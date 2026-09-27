import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
    readonly toolEffects?: Readonly<Record<string, "verified" | "dispatched-unknown" | "refused">>;
  },
  run: (handlers: Effect.Success<typeof make>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const handlers = yield* make;
    return yield* run(handlers);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
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
              },
            },
            activeMission: input.mission,
          }),
          activeMission: Effect.succeed(input.mission),
          call: (call) =>
            Effect.sync(() => {
              input.calls?.push({
                tool: call.tool,
                args: (call.args ?? {}) as Record<string, unknown>,
              });
              const forcedEffect = input.toolEffects?.[call.tool];
              if (forcedEffect !== undefined)
                return {
                  isError: forcedEffect === "refused",
                  degraded: false,
                  effect: forcedEffect,
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
        expect(state.elements).toHaveLength(1);
        expect(state.elements[0]).toMatchObject({ token: "s00000001:0", name: "5", x: 10, y: 20 });
      }),
    ),
  );

  it.effect("dispatches a click by element token", () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    return withToolkit({ mission, calls }, (handlers) =>
      Effect.gen(function* () {
        const result = yield* handlers.computer_click({
          pid: 99,
          windowId: 12,
          elementToken: "s00000001:0",
        });
        expect(result.ok).toBe(true);
        expect(calls.at(-1)).toMatchObject({
          tool: "click",
          args: { element_token: "s00000001:0", pid: 99, window_id: 12 },
        });
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
        const error = yield* Effect.flip(
          handlers.computer_click({ pid: 1, windowId: 1, x: 5, y: 5 }),
        );
        expect(error).toMatchObject({ code: "mission-owner-mismatch" });
      }),
    ),
  );

  it.effect("reports an uncertain action as ok=false with its effect", () =>
    withToolkit({ mission, toolEffects: { click: "dispatched-unknown" } }, (handlers) =>
      Effect.gen(function* () {
        const result = yield* handlers.computer_click({ pid: 1, windowId: 1, x: 5, y: 5 });
        expect(result.ok).toBe(false);
        expect(result.effect).toBe("dispatched-unknown");
      }),
    ),
  );

  it.effect("surfaces a service mission error as a tool failure", () => {
    const failing = Layer.mock(ComputerService)({
      activeMission: Effect.succeed(mission),
      call: () => Effect.fail(new ComputerMissionError({ reason: "host went away" })),
    });
    return Effect.gen(function* () {
      const handlers = yield* make;
      const error = yield* Effect.flip(
        handlers.computer_click({ pid: 1, windowId: 1, x: 5, y: 5 }),
      );
      expect(error).toMatchObject({ code: "computer-unavailable", message: "host went away" });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          failing,
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
