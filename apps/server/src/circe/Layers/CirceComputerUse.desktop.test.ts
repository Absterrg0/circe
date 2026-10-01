import type { ComputerHostToolResult } from "@circe/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  ComputerService,
  type ComputerMission,
  type ComputerMissionOwner,
} from "../../computer/ComputerService.ts";
import { loadCirceCore, type Jev, type JevRequest } from "../host/core.ts";
import { CirceComputerUse, type CirceComputerGoal } from "../Services/CirceComputerUse.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";
import {
  CirceDesktopPlanUnavailable,
  CirceRecoveryPlanner,
} from "../Services/CirceRecoveryPlanner.ts";
import { CirceMissionCancellationLive } from "./CirceMissionCancellation.ts";
import { make } from "./CirceComputerUse.ts";

// The private core is not in public checkouts; these tests need its executor.
const core = await loadCirceCore();
const runDesktopGoal = core?.runDesktopGoal;

const result = (
  effect: ComputerHostToolResult["effect"],
  structured?: unknown,
  isError = false,
): ComputerHostToolResult => ({
  isError,
  degraded: false,
  effect,
  text: isError ? "failed" : "ok",
  ...(structured === undefined ? {} : { structured }),
  images: [],
});

const MUTATIONS = new Set(["click", "set_value", "press_key", "scroll", "launch_app"]);

/**
 * A desktop with one calculator, shaped like GNOME Calculator over AT-SPI:
 * an editable entry, a read-only result line, digit buttons, and "=" whose
 * description is "Calculate Result". Snapshots advance on every read, so an
 * old element token is stale, as with the real driver.
 */
function fakeDesktop(
  options: { readonly open?: boolean; readonly typeResult?: ComputerHostToolResult } = {},
) {
  let open = options.open ?? false;
  let entry = "";
  let snapshot = 0;
  const calls: Array<{
    tool: string;
    args: Record<string, unknown>;
    missionId: string;
    owner: ComputerMissionOwner | undefined;
  }> = [];
  const begins: ComputerMission[] = [];
  const ended: string[] = [];
  let active: ComputerMission | undefined;
  const window = {
    window_id: 75,
    pid: 4242,
    app_name: "Calculator",
    title: "Calculator",
    z_index: 3,
    is_on_screen: true,
  };
  const tree = () => {
    snapshot += 1;
    const s = `s${snapshot}`;
    const element = (index: number, fields: Record<string, unknown>) => ({
      element_index: index,
      element_token: `${s}:${index}`,
      frame: { x: 0, y: 0, w: 10, h: 10 },
      enabled: true,
      ...fields,
    });
    return {
      pid: 4242,
      window_id: 75,
      app_name: "Calculator",
      window_title: "Calculator",
      snapshot_id: s,
      elements_complete: true,
      elements: [
        element(0, { role: "window", label: "Calculator" }),
        element(1, {
          role: "text box",
          ...(entry === "" ? {} : { label: entry, value: entry }),
          actions: ["clipboard.copy", "text.clear"],
        }),
        element(2, { role: "text box", actions: ["clipboard.copy", "selection.select-all"] }),
        ...["7", "8", "9", "4", "5", "6", "1", "2", "3", "0"].map((digit, offset) =>
          element(3 + offset, { role: "button", label: digit, actions: ["click"] }),
        ),
        element(13, {
          role: "button",
          label: "×",
          description: "Multiply [*]",
          actions: ["click"],
        }),
        element(14, {
          role: "button",
          label: "=",
          description: "Calculate Result",
          actions: ["click"],
        }),
      ],
    };
  };
  const tokenLabel = (token: unknown) => {
    const index = Number(String(token).split(":")[1]);
    return index === 14 ? "=" : index === 1 ? "entry" : "other";
  };
  const service = Layer.mock(ComputerService)({
    status: Effect.sync(() => ({
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
          visualGrounding: false,
        },
      },
      activeMission: active,
    })),
    activeMission: Effect.sync(() => active),
    events: Stream.empty,
    beginMission: (input) =>
      Effect.sync(() => {
        const mission: ComputerMission = {
          id: `mission-${begins.length + 1}`,
          goal: input.goal,
          source: input.source,
          owner: input.owner,
          startedAtMs: 0,
        };
        begins.push(mission);
        active = mission;
        return mission;
      }),
    endMission: (input) =>
      Effect.sync(() => {
        ended.push(input.missionId);
        active = undefined;
      }),
    stop: () => Effect.void,
    call: (input) =>
      Effect.sync(() => {
        const args = (input.args ?? {}) as Record<string, unknown>;
        calls.push({ tool: input.tool, args, missionId: input.missionId, owner: input.owner });
        const current = String(snapshot === 0 ? "" : `s${snapshot}`);
        switch (input.tool) {
          case "list_apps":
            return result("verified", {
              apps: [
                {
                  pid: 0,
                  name: "Calculator",
                  running: false,
                  kind: "desktop",
                  launch_path: "gnome-calculator",
                },
                {
                  pid: 0,
                  name: "LibreOffice Calc",
                  running: false,
                  kind: "desktop",
                  launch_path: "libreoffice --calc",
                },
                { pid: 99, name: "gsd-xsettings", running: true, kind: null },
              ],
            });
          case "list_windows":
            return result("verified", { windows: open ? [window] : [] });
          case "launch_app":
            open = true;
            return result("dispatched-unknown", { pid: 4242, windows: [window] });
          case "get_window_state":
            return result("verified", tree());
          case "set_value":
            if (options.typeResult !== undefined) return options.typeResult;
            if (String(args.element_token).split(":")[0] !== current)
              return result("not-dispatched", undefined, true);
            if (tokenLabel(args.element_token) === "entry") entry = String(args.value);
            return result("verified");
          case "click":
            if (String(args.element_token).split(":")[0] !== current)
              return result("not-dispatched", undefined, true);
            if (tokenLabel(args.element_token) === "=")
              entry = String(entry.split("*").reduce((product, part) => product * Number(part), 1));
            return result("dispatched-unknown");
          default:
            return result("verified");
        }
      }),
  });
  return {
    layer: service,
    calls,
    begins,
    ended,
    mutations: () => calls.filter((call) => MUTATIONS.has(call.tool)),
    shows: () => entry,
    hold: (mission: ComputerMission) => {
      active = mission;
    },
  };
}

/** Jev that takes the first offered option confidently, and says yes; `down` makes every call fail. */
const scriptedJev = (asked: JevRequest[], down = false): Jev => ({
  async ask(request) {
    asked.push(request);
    if (down) throw new Error("TypeSafe unreachable");
    return {
      model: "jev-test",
      usage: { input_tokens: 0, output_tokens: 0 },
      latencyMs: 1,
      cached: false,
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => {
          if (question.type !== "choice") return [id, { type: "noul" as const, noul: 0.95 }];
          const options = Object.keys(
            (question as unknown as { criteria: Record<string, unknown> }).criteria,
          );
          const probabilities = Object.fromEntries(
            options.map((option, index) => [
              option,
              index === 0 ? 0.9 : 0.1 / (options.length - 1),
            ]),
          );
          return [
            id,
            { type: "choice" as const, choice: options[0]!, confidence: 0.9, probabilities },
          ];
        }),
      ),
    };
  },
});

const multiplyPlan = {
  steps: [
    { verb: "fill", intent: "enter the product", target: { role: "text box" }, text: "12*7" },
    { verb: "click", intent: "calculate", target: { role: "button", name: "=" } },
  ],
  done: { shows: "84" },
};

const setup = (options: {
  readonly desktop: ReturnType<typeof fakeDesktop>;
  readonly asked?: JevRequest[];
  readonly jevDown?: boolean;
  readonly plans?: unknown[];
  readonly prompts?: string[];
}) => {
  const plans = [...(options.plans ?? [multiplyPlan])];
  const planner = Layer.mock(CirceRecoveryPlanner)({
    planDesktop: (prompt) => {
      options.prompts?.push(prompt);
      const next = plans.shift();
      return next === undefined
        ? Effect.fail(new CirceDesktopPlanUnavailable({ reason: "no model" }))
        : Effect.succeed(next);
    },
  });
  return Layer.effect(
    CirceComputerUse,
    make({
      desktop: Effect.succeed(
        runDesktopGoal === undefined
          ? undefined
          : { runDesktopGoal, jev: scriptedJev(options.asked ?? [], options.jevDown) },
      ),
    }),
  ).pipe(
    Layer.provide(options.desktop.layer),
    Layer.provide(planner),
    Layer.provideMerge(CirceMissionCancellationLive),
  );
};

const goal = "work out twelve times seven in the calculator";

describe.skipIf(runDesktopGoal === undefined)("Circe desktop goals through circe-core", () => {
  it.effect(
    "carries out a spoken calculation in the app, grounding each step and verifying the display",
    () => {
      const desktop = fakeDesktop();
      const asked: JevRequest[] = [];
      const prompts: string[] = [];
      return Effect.gen(function* () {
        const executor = yield* CirceComputerUse;
        const outcome = yield* executor.run({
          goal,
          confirmed: true,
          requestMetadata: { requestId: "voice-1" } as never,
        });
        expect(outcome.status).toBe("done");
        expect(desktop.shows()).toBe("84");
        // One mission of its own, begun and ended; every call inside it.
        expect(desktop.begins).toHaveLength(1);
        expect(desktop.ended).toEqual(["mission-1"]);
        expect(new Set(desktop.calls.map((call) => call.missionId))).toEqual(
          new Set(["mission-1"]),
        );
        // Launched once, typed the whole expression once, activated "=" once.
        expect(desktop.mutations().map((call) => call.tool)).toEqual([
          "launch_app",
          "set_value",
          "click",
        ]);
        expect(desktop.mutations()[1]?.args).toMatchObject({
          value: "12*7",
          pid: 4242,
          window_id: 75,
          delivery_mode: "background",
        });
        // The planner saw the real window; code resolved its unique field and checked the display.
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain('button "=" (Calculate Result)');
        // "calculator" also names LibreOffice Calc: Jev chose between the two apps.
        expect(asked.map((request) => Object.keys(request.questions))).toEqual([["app"]]);
        const apps = asked[0]?.questions.app as unknown as {
          readonly criteria: Record<string, unknown>;
        };
        expect(Object.values(apps.criteria)).toEqual(
          expect.arrayContaining(["Calculator", "LibreOffice Calc"]),
        );
      }).pipe(Effect.provide(setup({ desktop, asked, prompts })));
    },
  );

  it.effect("reuses the calculator that is already open", () => {
    const desktop = fakeDesktop({ open: true });
    return Effect.gen(function* () {
      const outcome = yield* (yield* CirceComputerUse).run({ goal, confirmed: true });
      expect(outcome.status).toBe("done");
      expect(desktop.calls.some((call) => call.tool === "launch_app")).toBe(false);
    }).pipe(Effect.provide(setup({ desktop })));
  });

  it.effect("runs a provider's goal inside its granted mission without starting another", () => {
    const desktop = fakeDesktop({ open: true });
    const owner: ComputerMissionOwner = {
      kind: "provider",
      threadId: "thread-1",
      providerSessionId: "session-1",
    };
    const granted: ComputerMission = {
      id: "agent-mission",
      goal,
      source: "agent",
      owner,
      startedAtMs: 0,
    };
    desktop.hold(granted);
    return Effect.gen(function* () {
      const goalInput: CirceComputerGoal = {
        goal,
        stopped: Effect.succeed(false),
        plan: multiplyPlan,
      };
      const outcome = yield* (yield* CirceComputerUse).runInMission(granted, goalInput);
      expect(outcome.status).toBe("done");
      expect(desktop.begins).toHaveLength(0);
      expect(desktop.ended).toHaveLength(0);
      expect(
        desktop.calls.every((call) => call.missionId === "agent-mission" && call.owner === owner),
      ).toBe(true);
    }).pipe(Effect.provide(setup({ desktop, plans: [] })));
  });

  it.effect("sends nothing more once the goal is stopped", () => {
    const desktop = fakeDesktop({ open: true });
    const granted: ComputerMission = {
      id: "agent-mission",
      goal,
      source: "agent",
      owner: { kind: "client" },
      startedAtMs: 0,
    };
    desktop.hold(granted);
    return Effect.gen(function* () {
      const stopped = Effect.sync(() => desktop.mutations().length >= 1);
      const outcome = yield* (yield* CirceComputerUse).runInMission(granted, { goal, stopped });
      expect(outcome.status).toBe("cancelled");
      expect(desktop.mutations().map((call) => call.tool)).toEqual(["set_value"]);
    }).pipe(Effect.provide(setup({ desktop })));
  });

  it.effect("stops after typing of unknown delivery and never repeats it", () => {
    const desktop = fakeDesktop({
      open: true,
      typeResult: result("dispatched-unknown", undefined, true),
    });
    return Effect.gen(function* () {
      const outcome = yield* (yield* CirceComputerUse).run({ goal, confirmed: true });
      expect(outcome.status).toBe("refused");
      expect(outcome.message).toContain("can't tell whether it reached the app");
      expect(desktop.mutations().map((call) => call.tool)).toEqual(["set_value"]);
    }).pipe(Effect.provide(setup({ desktop })));
  });

  it.effect("reports Jev being unreachable without touching the desktop", () => {
    const desktop = fakeDesktop({ open: true });
    return Effect.gen(function* () {
      const outcome = yield* (yield* CirceComputerUse).run({ goal, confirmed: true });
      expect(outcome.status).toBe("unavailable");
      expect(desktop.mutations()).toEqual([]);
    }).pipe(Effect.provide(setup({ desktop, jevDown: true })));
  });

  it.effect("reports a missing planning model without touching the desktop", () => {
    const desktop = fakeDesktop({ open: true });
    return Effect.gen(function* () {
      const outcome = yield* (yield* CirceComputerUse).run({ goal, confirmed: true });
      expect(outcome.status).toBe("unavailable");
      expect(desktop.mutations()).toEqual([]);
    }).pipe(Effect.provide(setup({ desktop, plans: [] })));
  });

  it.effect("refuses a goal the planner says cannot be done here", () => {
    const desktop = fakeDesktop({ open: true });
    return Effect.gen(function* () {
      const outcome = yield* (yield* CirceComputerUse).run({
        goal: "call my mother",
        confirmed: true,
      });
      expect(outcome).toMatchObject({
        status: "refused",
        message: "This computer can't place phone calls.",
      });
      expect(desktop.mutations()).toEqual([]);
    }).pipe(
      Effect.provide(
        setup({
          desktop,
          plans: [{ steps: [], unsupported: "This computer can't place phone calls." }],
        }),
      ),
    );
  });
});

// Keeps the cancellation registry in the type of the layer under test.
export type _Uses = CirceMissionCancellation;
