import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { describe, expect, it } from "@effect/vitest";

import type { ComputerHostToolResult } from "@circe/contracts";

import {
  ComputerMissionError,
  ComputerService,
  type ComputerMission,
  type ComputerServiceEvent,
  type ComputerServiceShape,
} from "../../computer/ComputerService.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";
import { CirceMissionCancellationLive } from "./CirceMissionCancellation.ts";
import { make } from "./CirceComputerUse.ts";

const ok = (structured?: unknown): ComputerHostToolResult => ({
  isError: false,
  degraded: false,
  effect: "verified",
  text: "ok",
  ...(structured === undefined ? {} : { structured }),
  images: [],
});

const refused = (text: string): ComputerHostToolResult => ({
  isError: true,
  degraded: false,
  effect: "refused",
  text,
  refusalCode: "driver-refused",
  images: [],
});

interface FakeComputer {
  readonly calls: Array<{ tool: string; args: Record<string, unknown>; missionId: string }>;
  readonly begins: Array<ComputerMission>;
  readonly ended: string[];
  readonly stops: string[];
  available: boolean;
  beginFails: boolean;
  clickRefused: boolean;
  clickUnknown: boolean;
  clickUnknownTransport: boolean;
  clickRefusedNoError: boolean;
  appsRunning: boolean;
  launchUnknown: boolean;
  launchUnknownTransport: boolean;
  launchRefusedNoError: boolean;
  elementTypeRefused: boolean;
  launched: boolean;
  baseWindows: ReadonlyArray<Record<string, unknown>>;
  postLaunchWindows: ReadonlyArray<Record<string, unknown>>;
  windowTitle: string;
  observationCount: number;
  readonly activeMission: () => ComputerMission | undefined;
}

const makeComputerLayer = (computer: FakeComputer) => {
  const shape: ComputerServiceShape = {
    status: Effect.succeed({
      available: computer.available,
      host: computer.available
        ? {
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
              visualGrounding: false,
            },
          }
        : undefined,
      activeMission: computer.activeMission(),
    }),
    beginMission: (input) => {
      if (computer.beginFails)
        return Effect.fail(new ComputerMissionError({ reason: "already active" }));
      const mission: ComputerMission = {
        id: `mission-${computer.begins.length + 1}`,
        goal: input.goal,
        source: input.source,
        owner: input.owner,
        startedAtMs: 0,
      };
      computer.begins.push(mission);
      return Effect.succeed(mission);
    },
    call: (input) =>
      Effect.sync(() => {
        computer.calls.push({
          tool: input.tool,
          args: (input.args ?? {}) as Record<string, unknown>,
          missionId: input.missionId,
        });
        switch (input.tool) {
          case "list_windows":
            return ok({
              windows: [
                ...(computer.launched ? computer.postLaunchWindows : []),
                ...computer.baseWindows,
              ],
            });
          case "list_apps":
            return ok({
              apps: [
                {
                  pid: 99,
                  name: "Calculator",
                  running: computer.appsRunning || computer.launched,
                  active: true,
                  launch_path: null,
                },
              ],
            });
          case "get_window_state": {
            // Each observation reflects the previous action, the way a real
            // surface does; a static surface makes the loop report a stall.
            computer.observationCount += 1;
            return ok({
              window_title: computer.windowTitle,
              app_name: "Calculator",
              snapshot_id: `s0000000${computer.observationCount % 10}`,
              elements: [
                {
                  element_token: `s0000000${computer.observationCount % 10}:0`,
                  role: "push button",
                  label: `Save ${computer.observationCount}`,
                  frame: { x: 700, y: 40, w: 80, h: 24 },
                  enabled: true,
                },
              ],
            });
          }
          case "click":
            if (computer.clickUnknown)
              return {
                isError: computer.clickUnknownTransport,
                degraded: false,
                effect: "dispatched-unknown" as const,
                text: "click dispatched; effect unknown",
                images: [],
              };
            if (computer.clickRefusedNoError)
              return {
                isError: false,
                degraded: false,
                effect: "refused" as const,
                text: "click refused without an error flag",
                images: [],
              };
            return computer.clickRefused ? refused("click refused") : ok();
          case "launch_app":
            computer.launched = true;
            if (computer.launchUnknown)
              return {
                isError: computer.launchUnknownTransport,
                degraded: false,
                effect: "dispatched-unknown" as const,
                text: "launch dispatched; effect unknown",
                structured: { pid: 99 },
                images: [],
              };
            if (computer.launchRefusedNoError)
              return {
                isError: false,
                degraded: false,
                effect: "refused" as const,
                text: "launch refused without an error flag",
                images: [],
              };
            return ok();
          case "set_value":
          case "type_text":
            if (
              computer.elementTypeRefused &&
              typeof (input.args as Record<string, unknown> | undefined)?.element_token === "string"
            )
              return refused("type refused");
            return ok();
          default:
            return ok();
        }
      }),
    endMission: (input) =>
      Effect.sync(() => {
        computer.ended.push(input.missionId);
      }),
    stop: (missionId) =>
      Effect.sync(() => {
        computer.stops.push(missionId ?? "active");
      }),
    events: Stream.empty as Stream.Stream<ComputerServiceEvent>,
    activeMission: Effect.sync(() => computer.activeMission()),
  };
  return Layer.succeed(ComputerService, ComputerService.of(shape));
};

const decideWith = (answers: ReadonlyArray<string>): Layer.Layer<CirceDecision> =>
  Layer.effect(
    CirceDecision,
    Effect.sync(() => {
      let index = 0;
      return CirceDecision.of({
        decide: (request: { readonly questions: Record<string, unknown> }) => {
          if ("goal_reached" in request.questions) {
            return Effect.succeed({
              status: "answered" as const,
              model: "jev-latest",
              answers: { goal_reached: { type: "noul" as const, noul: 0.95 } },
            });
          }
          const action = answers[Math.min(index, answers.length - 1)] ?? "done";
          index += 1;
          return Effect.succeed({
            status: "answered" as const,
            model: "jev-latest",
            answers: {
              action: {
                type: "choice" as const,
                choice: action,
                probabilities: { [action]: 0.95 },
                confidence: 0.95,
              },
              element: {
                type: "choice" as const,
                // The loop re-observes each step; element tokens are snapshot
                // scoped, so the fake selector names the newest one.
                choice: "s00000001:0",
                probabilities: { "s00000001:0": 0.95 },
                confidence: 0.95,
              },
              press_key: {
                type: "choice" as const,
                choice: "enter",
                probabilities: { enter: 0.95 },
                confidence: 0.95,
              },
              scroll_direction: {
                type: "choice" as const,
                choice: "down",
                probabilities: { down: 0.95 },
                confidence: 0.95,
              },
            },
          });
        },
      });
    }),
  );

const makeFakeComputer = (overrides: Partial<FakeComputer> = {}): FakeComputer => ({
  calls: [],
  begins: [],
  ended: [],
  stops: [],
  available: true,
  beginFails: false,
  clickRefused: false,
  clickUnknown: false,
  clickUnknownTransport: false,
  clickRefusedNoError: false,
  appsRunning: true,
  launchUnknown: false,
  launchUnknownTransport: false,
  launchRefusedNoError: false,
  elementTypeRefused: false,
  launched: false,
  baseWindows: [
    {
      window_id: 12,
      pid: 99,
      app_name: "Calculator",
      title: "Calculator",
      z_index: 1,
      is_on_screen: true,
    },
  ],
  postLaunchWindows: [],
  windowTitle: "Calculator",
  observationCount: 0,
  activeMission: () => undefined,
  ...overrides,
});

const testLayer = (input: {
  readonly computer: FakeComputer;
  readonly decisions?: ReadonlyArray<string>;
  readonly cancellation?: Layer.Layer<CirceMissionCancellation>;
}) =>
  Layer.effect(CirceComputerUse, make()).pipe(
    Layer.provide(makeComputerLayer(input.computer)),
    Layer.provide(decideWith(input.decisions ?? ["done"])),
    Layer.provide(input.cancellation ?? CirceMissionCancellationLive),
  );

const run = (
  input: {
    readonly goal: string;
    readonly confirmed?: boolean;
    readonly typeText?: string;
    readonly requestMetadata?: { readonly requestId: string };
  },
  layer: Layer.Layer<CirceComputerUse>,
) =>
  Effect.gen(function* () {
    const computerUse = yield* CirceComputerUse;
    return yield* computerUse.run({
      goal: input.goal,
      ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
      ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
      ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
    });
  }).pipe(Effect.provide(layer));

describe("Circe computer use", () => {
  it.effect("requires one confirmation before the first mission", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer();
      const result = yield* run(
        { goal: "save the document" },
        testLayer({ computer, decisions: ["done"] }),
      );
      expect(result.status).toBe("needs-input");
      expect(computer.begins).toHaveLength(0);
    }),
  );

  it.effect("reports unavailable when no desktop host is connected", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({ available: false });
      const result = yield* run(
        { goal: "save the document", confirmed: true },
        testLayer({ computer }),
      );
      expect(result.status).toBe("unavailable");
      expect(computer.begins).toHaveLength(0);
    }),
  );

  it.effect("runs a grounded mission through the computer service and ends it", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer();
      const result = yield* run(
        { goal: "save the document", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      );
      expect(result.status).toBe("done");
      const tools = computer.calls.map((call) => call.tool);
      expect(tools[0]).toBe("list_windows");
      expect(tools).toContain("get_window_state");
      expect(tools).toContain("click");
      const click = computer.calls.find((call) => call.tool === "click");
      expect(click?.args).toMatchObject({
        element_token: "s00000001:0",
        delivery_mode: "background",
      });
      expect(computer.begins).toHaveLength(1);
      expect(computer.ended).toContain(computer.begins[0]!.id);
    }),
  );

  it.effect("refuses honestly when a mutation is refused by the driver", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({ clickRefused: true });
      const result = yield* run(
        { goal: "save the document", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      );
      expect(result.status).toBe("refused");
      expect(computer.ended).toHaveLength(1);
    }),
  );

  it.effect("continues after an unverifiable click only through a fresh observation", () =>
    Effect.gen(function* () {
      // The driver completed the dispatch but could not observe its effect,
      // as it reports for pixel clicks. The click is never re-dispatched; the
      // next decision is made on a new observation and completion rests on
      // the goal check, not on the click.
      const computer = makeFakeComputer({ clickUnknown: true });
      const result = yield* run(
        { goal: "save the document", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      );
      expect(result.status).toBe("done");
      const tools = computer.calls.map((call) => call.tool);
      expect(tools.filter((tool) => tool === "click")).toHaveLength(1);
      expect(tools.slice(tools.indexOf("click") + 1)).toContain("get_window_state");
    }),
  );

  it.effect("stops on a click whose delivery itself is unknown, exactly once", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({ clickUnknown: true, clickUnknownTransport: true });
      const result = yield* run(
        { goal: "save the document", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      );
      expect(result.status).toBe("refused");
      expect(result.status === "refused" ? result.message : "").toMatch(/won't repeat/i);
      expect(computer.calls.filter((call) => call.tool === "click")).toHaveLength(1);
    }),
  );

  it.effect("refuses a refused effect even when isError is false", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({ clickRefusedNoError: true });
      const result = yield* run(
        { goal: "save the document", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      );
      expect(result.status).toBe("refused");
      expect(computer.calls.filter((call) => call.tool === "click")).toHaveLength(1);
    }),
  );

  it.effect("continues a clean unverified calculator launch only after observing its window", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({
        appsRunning: false,
        baseWindows: [],
        launchUnknown: true,
        postLaunchWindows: [
          {
            window_id: 12,
            pid: 99,
            app_name: "gnome-calculator",
            title: "Calculator",
            is_on_screen: true,
          },
        ],
      });
      const result = yield* run(
        { goal: "open calculator and type five plus eight", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      );
      expect(result.status).toBe("done");
      const tools = computer.calls.map((call) => call.tool);
      expect(tools.filter((tool) => tool === "launch_app")).toHaveLength(1);
      expect(tools.slice(tools.indexOf("launch_app") + 1, tools.indexOf("click"))).toContain(
        "list_windows",
      );
      expect(tools.filter((tool) => tool === "click")).toHaveLength(1);
    }),
  );

  it.effect("does not act on a same-name window owned by another process after launch", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({
        appsRunning: false,
        baseWindows: [],
        launchUnknown: true,
        postLaunchWindows: [
          {
            window_id: 13,
            pid: 88,
            app_name: "Calculator",
            title: "Calculator",
            is_on_screen: true,
          },
        ],
      });
      const mission = yield* run(
        { goal: "open calculator and type five plus eight", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("20 seconds");
      const result = yield* Fiber.join(mission);
      expect(result.status).toBe("unavailable");
      expect(computer.calls.filter((call) => call.tool === "launch_app")).toHaveLength(1);
      expect(computer.calls.filter((call) => call.tool === "click")).toHaveLength(0);
    }),
  );

  it.effect("uses the running application's pid when its window has an executable name", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({
        baseWindows: [
          {
            window_id: 12,
            pid: 99,
            app_name: "gnome-calculator",
            title: "Calculator",
            is_on_screen: true,
          },
          {
            window_id: 13,
            pid: 88,
            app_name: "Calculator",
            title: "Unrelated",
            is_on_screen: true,
          },
        ],
      });
      const result = yield* run(
        { goal: "type five plus eight in calculator", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      );
      expect(result.status).toBe("done");
      expect(computer.calls.find((call) => call.tool === "get_window_state")?.args).toMatchObject({
        pid: 99,
        window_id: 12,
      });
      expect(computer.calls.filter((call) => call.tool === "launch_app")).toHaveLength(0);
    }),
  );

  it.effect("refuses unknown launch delivery instead of continuing to click", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({ launchUnknown: true, launchUnknownTransport: true });
      const result = yield* run(
        { goal: "open youtube and search cats", confirmed: true },
        testLayer({ computer, decisions: ["click", "done"] }),
      );
      expect(result.status).toBe("refused");
      expect(result.status === "refused" ? result.message : "").toMatch(/won't repeat/i);
      expect(computer.calls.filter((call) => call.tool === "click")).toHaveLength(0);
    }),
  );

  it.effect("never targets an unrelated window that appears during a URL launch", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({
        baseWindows: [
          {
            window_id: 8,
            pid: 7,
            app_name: "Google Chrome",
            title: "Chrome",
            z_index: 1,
            is_on_screen: true,
          },
        ],
        postLaunchWindows: [
          {
            window_id: 99,
            pid: 88,
            app_name: "Text Editor",
            title: "Editor",
            is_on_screen: true,
          },
          {
            window_id: 9,
            pid: 7,
            app_name: "Google Chrome",
            title: "YouTube",
            is_on_screen: true,
          },
        ],
      });
      const result = yield* run(
        { goal: "open youtube and search cats", confirmed: true },
        testLayer({ computer, decisions: ["done"] }),
      );
      expect(result.status).toBe("done");
      const observed = computer.calls.find((call) => call.tool === "get_window_state");
      expect(observed?.args).toMatchObject({ pid: 7, window_id: 9 });
    }),
  );

  it.effect("types only into the grounded element and never retries untargeted", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer({ elementTypeRefused: true });
      const result = yield* run(
        { goal: "save the document", confirmed: true, typeText: "hello" },
        testLayer({ computer, decisions: ["type", "done"] }),
      );
      expect(result.status).toBe("refused");
      // A fill replaces through the guarded set_value mutation.
      const types = computer.calls.filter((call) => call.tool === "set_value");
      expect(types).toHaveLength(1);
      expect(types[0]?.args).toMatchObject({
        pid: 99,
        window_id: 12,
        element_token: "s00000001:0",
      });
      expect(types[0]?.args.session).toBeUndefined();
    }),
  );

  it.effect("binds keyboard and scroll to the mission window", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer();
      const result = yield* run(
        { goal: "save the document", confirmed: true },
        testLayer({ computer, decisions: ["press", "scroll", "done"] }),
      );
      expect(result.status).toBe("done");
      const press = computer.calls.find((call) => call.tool === "press_key");
      const scroll = computer.calls.find((call) => call.tool === "scroll");
      expect(press?.args).toMatchObject({ pid: 99, window_id: 12, key: "enter" });
      expect(scroll?.args).toMatchObject({ pid: 99, window_id: 12, direction: "down" });
    }),
  );

  it.effect("starts a client-owned mission and reports a stop as cancelled", () =>
    Effect.gen(function* () {
      const computer = makeFakeComputer();
      const cancellation = Layer.effect(
        CirceMissionCancellation,
        Effect.gen(function* () {
          const cancelled = yield* SynchronizedRef.make(true);
          return CirceMissionCancellation.of({
            register: () => Effect.void,
            isCancelled: () => SynchronizedRef.get(cancelled),
            requestStop: () => Effect.succeed(true),
            clear: () => Effect.void,
            isActive: () => Effect.succeed(true),
            awaitSettled: () => Effect.succeed(true),
          });
        }),
      );
      const result = yield* run(
        { goal: "save the document", confirmed: true, requestMetadata: { requestId: "req-1" } },
        testLayer({ computer, cancellation, decisions: ["done"] }),
      );
      expect(result.status).toBe("cancelled");
      expect(result).toMatchObject({ steps: 0 });
      expect(computer.ended).toHaveLength(1);
      expect(computer.begins[0]?.owner).toEqual({ kind: "client" });
    }),
  );
});
