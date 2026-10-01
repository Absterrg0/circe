import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import type { ComputerHostToolResult } from "@circe/contracts";

import {
  ComputerService,
  type ComputerMission,
  type ComputerServiceEvent,
} from "../../computer/ComputerService.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";
import { CirceMissionCancellationLive } from "./CirceMissionCancellation.ts";
import { make } from "./CirceComputerUse.ts";

/**
 * Native-versus-visual grounding through the real mission loop. The fake
 * computer answers each Cua tool from a script and records every call with
 * its arguments, so each test can assert exactly which observation, parse
 * and click the mission sent, and which it never sent.
 */

const PID = 42;
const WINDOW = 7;

const ok = (structured?: unknown): ComputerHostToolResult => ({
  isError: false,
  degraded: false,
  effect: "verified",
  text: "ok",
  ...(structured === undefined ? {} : { structured }),
  images: [],
});

const driverError = (driverCode: string): ComputerHostToolResult => ({
  isError: true,
  degraded: false,
  effect: "refused",
  text: `refused: ${driverCode}`,
  refusalCode: "driver-refused",
  driverCode,
  images: [],
});

const frame = { x: 0, y: 0, w: 760, h: 460 };

/** Only the window root is visible, as Tk and other custom-drawn apps report. */
const chromeOnly = (snapshot: string, captureId: string | undefined) => ({
  pid: PID,
  window_id: WINDOW,
  app_name: "Canvas",
  window_title: "Canvas",
  snapshot_id: snapshot,
  ...(captureId === undefined ? {} : { capture_id: captureId }),
  screenshot_width: 760,
  screenshot_height: 460,
  elements_complete: false,
  degraded: true,
  degraded_reason: "x11_property_fallback_partial: AT-SPI was unavailable",
  elements: [
    {
      element_index: 0,
      element_token: `${snapshot}:0`,
      role: "window",
      label: "Canvas",
      frame,
    },
  ],
});

/** A complete tree with one real button. */
const withButton = (snapshot: string, label: string, extra: Record<string, unknown> = {}) => ({
  pid: PID,
  window_id: WINDOW,
  app_name: "Canvas",
  window_title: "Canvas",
  snapshot_id: snapshot,
  elements_complete: true,
  elements: [
    { element_index: 0, element_token: `${snapshot}:0`, role: "frame", label: "Canvas", frame },
    {
      element_index: 1,
      parent_index: 0,
      element_token: `${snapshot}:1`,
      role: "push button",
      label,
      enabled: true,
      frame: { x: 300, y: 270, w: 60, h: 24 },
    },
  ],
  ...extra,
});

const visualResult = (captureId: string, source = { pid: PID, window_id: WINDOW }) => ({
  schema: "cua.visual_regions_v1",
  capture: {
    capture_id: captureId,
    source: { kind: "window", ...source },
    screenshot: { mime_type: "image/png", reference: "png-sha256:abc", width: 760, height: 460 },
    action_coordinate_space: { kind: "screenshot_pixels" },
  },
  parser: {
    extension_id: "cua-perception",
    extension_version: "0.3.0",
    model_id: "m",
    model_version: "1",
  },
  timing: { duration_ms: 5 },
  regions: [
    {
      id: "text-1",
      kind: "text",
      text: "Choose a signal",
      confidence: 0.8,
      interactive: false,
      bounds: { x: 37, y: 31, width: 96, height: 18 },
    },
    {
      id: "icon-2",
      kind: "icon",
      label: "icon-class-0",
      confidence: 0.24,
      interactive: false,
      bounds: { x: 292, y: 132, width: 204, height: 178 },
    },
    {
      id: "text-3",
      kind: "text",
      text: "Send",
      confidence: 0.74,
      interactive: false,
      bounds: { x: 378, y: 274, width: 31, height: 17 },
    },
    {
      id: "icon-4",
      kind: "icon",
      label: "icon-class-0",
      confidence: 0.3,
      interactive: false,
      bounds: { x: 72, y: 132, width: 204, height: 178 },
    },
    {
      id: "text-5",
      kind: "text",
      text: "Save",
      confidence: 0.69,
      interactive: false,
      bounds: { x: 158, y: 273, width: 33, height: 19 },
    },
  ],
});

interface Call {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

interface Script {
  readonly visualGrounding?: boolean;
  /** Structured get_window_state result for the nth observation (0-based). */
  readonly windowState: (index: number, args: Record<string, unknown>) => unknown;
  readonly parse?: (args: Record<string, unknown>) => ComputerHostToolResult;
  readonly click?: (index: number, args: Record<string, unknown>) => ComputerHostToolResult;
  /** Runs before a tool answers, with the mission cancellation service in scope. */
  readonly before?: (
    tool: string,
    cancellation: CirceMissionCancellation["Service"],
  ) => Effect.Effect<void>;
}

const computerLayer = (script: Script, calls: Array<Call>) =>
  Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const cancellation = yield* CirceMissionCancellation;
      let observations = 0;
      let clicks = 0;
      let active: ComputerMission | undefined;
      return ComputerService.of({
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
              visualGrounding: script.visualGrounding ?? true,
            },
          },
          activeMission: active,
        })),
        beginMission: (input) =>
          Effect.sync(() => {
            active = {
              id: "mission-1",
              goal: input.goal,
              source: input.source,
              owner: input.owner,
              startedAtMs: 0,
            };
            return active;
          }),
        call: (input) =>
          Effect.gen(function* () {
            const args = (input.args ?? {}) as Record<string, unknown>;
            calls.push({ tool: input.tool, args });
            if (script.before !== undefined) yield* script.before(input.tool, cancellation);
            switch (input.tool) {
              case "list_windows":
                return ok({
                  windows: [
                    {
                      window_id: WINDOW,
                      pid: PID,
                      app_name: "Canvas",
                      title: "Canvas",
                      z_index: 1,
                      is_on_screen: true,
                    },
                  ],
                });
              case "list_apps":
                return ok({ apps: [{ pid: PID, name: "Canvas", running: true, active: true }] });
              case "get_window_state": {
                const index = observations;
                observations += 1;
                return ok(script.windowState(index, args));
              }
              case "parse_visual_regions":
                return script.parse === undefined
                  ? driverError("not_installed")
                  : script.parse(args);
              case "click": {
                const index = clicks;
                clicks += 1;
                return script.click === undefined ? ok() : script.click(index, args);
              }
              default:
                return ok();
            }
          }),
        endMission: () =>
          Effect.sync(() => {
            active = undefined;
          }),
        stop: () => Effect.void,
        events: Stream.empty as Stream.Stream<ComputerServiceEvent>,
        activeMission: Effect.sync(() => active),
      });
    }),
  );

type Step =
  | { readonly action: "click"; readonly name: string }
  | { readonly action: "done" }
  | { readonly action: "type"; readonly name: string };

/**
 * Chooses each step by the visible name of an offered element, as a model
 * reads the criteria it was given. It never sees executable addresses.
 */
const decideByName = (
  steps: ReadonlyArray<Step>,
  seen: Array<Record<string, string | null>>,
  before?: (cancellation: CirceMissionCancellation["Service"]) => Effect.Effect<void>,
  verify?: (state: unknown) => boolean,
) =>
  Layer.effect(
    CirceDecision,
    Effect.gen(function* () {
      const cancellation = yield* CirceMissionCancellation;
      let index = 0;
      return CirceDecision.of({
        decide: (request) =>
          Effect.gen(function* () {
            if ("goal_reached" in request.questions)
              return {
                status: "answered" as const,
                model: "jev-latest",
                answers: {
                  goal_reached: {
                    type: "noul" as const,
                    noul: (verify?.(request.state) ?? true) ? 0.95 : 0.05,
                  },
                },
              };
            if (before !== undefined) yield* before(cancellation);
            const step = steps[Math.min(index, steps.length - 1)]!;
            index += 1;
            const criteria =
              (
                request.questions.element as
                  | { criteria?: Record<string, string | null> }
                  | undefined
              )?.criteria ?? {};
            seen.push(criteria);
            const wanted = step.action === "done" ? undefined : step.name;
            const element =
              wanted === undefined
                ? undefined
                : Object.entries(criteria).find(([, label]) => label?.endsWith(`: ${wanted}`))?.[0];
            const choice = (value: string) => ({
              type: "choice" as const,
              choice: value,
              probabilities: { [value]: 0.95 },
              confidence: 0.95,
            });
            return {
              status: "answered" as const,
              model: "jev-latest",
              answers: {
                action: choice(step.action),
                ...(element === undefined ? {} : { element: choice(element) }),
                type_text: choice("hello"),
              },
            };
          }),
      });
    }),
  );

const runMission = (
  script: Script,
  steps: ReadonlyArray<Step>,
  options: {
    readonly goal?: string;
    readonly requestId?: string;
    readonly verify?: (state: unknown) => boolean;
    readonly beforeDecision?: (
      cancellation: CirceMissionCancellation["Service"],
    ) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const calls: Array<Call> = [];
    const seen: Array<Record<string, string | null>> = [];
    const layer = Layer.effect(CirceComputerUse, make()).pipe(
      Layer.provide(
        Layer.mergeAll(
          computerLayer(script, calls),
          decideByName(steps, seen, options.beforeDecision, options.verify),
        ),
      ),
      Layer.provideMerge(CirceMissionCancellationLive),
    );
    const result = yield* Effect.gen(function* () {
      const computerUse = yield* CirceComputerUse;
      return yield* computerUse.run({
        goal: options.goal ?? "choose the send signal in Canvas",
        confirmed: true,
        ...(options.requestId === undefined
          ? {}
          : { requestMetadata: { requestId: options.requestId } }),
      });
    }).pipe(Effect.provide(layer));
    return { result, calls, seen };
  });

const tools = (calls: ReadonlyArray<Call>, name: string) =>
  calls.filter((call) => call.tool === name);

describe("desktop grounding", () => {
  it.effect("acts on a native element by its token and never parses the screen", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        { windowState: (index) => withButton(`s${index}`, "Send") },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("done");
      const clicks = tools(calls, "click");
      expect(clicks).toHaveLength(1);
      expect(clicks[0]!.args.element_token).toBe("s0:1");
      expect(clicks[0]!.args.capture_id).toBeUndefined();
      expect(clicks[0]!.args.x).toBeUndefined();
      expect(tools(calls, "parse_visual_regions")).toHaveLength(0);
      expect(
        tools(calls, "get_window_state").every((call) => call.args.include_screenshot === false),
      ).toBe(true);
    }),
  );

  it.effect("falls back to the capture of a chrome-only window and clicks through it", () =>
    Effect.gen(function* () {
      const { result, calls, seen } = yield* runMission(
        {
          windowState: (index, args) =>
            chromeOnly(`s${index}`, args.include_screenshot === true ? `cap-${index}` : undefined),
          parse: (args) => ok(visualResult(String(args.capture_id))),
        },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("done");
      const observations = tools(calls, "get_window_state");
      // Cheap native look first, then one observation that carries the capture.
      expect(observations[0]!.args.include_screenshot).toBe(false);
      expect(observations[1]!.args.include_screenshot).toBe(true);
      const parses = tools(calls, "parse_visual_regions");
      expect(parses[0]!.args.capture_id).toBe("cap-1");
      // The model saw the region by name only, marked as read from the screen.
      expect(Object.values(seen[0]!).some((label) => label?.includes("seen on screen"))).toBe(true);
      expect(Object.keys(seen[0]!).some((id) => id.includes("cap-1"))).toBe(false);
      const clicks = tools(calls, "click");
      expect(clicks).toHaveLength(1);
      // The detected card that contains "Send" is clicked at its center, bound
      // to the capture it was read from.
      expect(clicks[0]!.args).toMatchObject({
        pid: PID,
        window_id: WINDOW,
        x: 292 + 204 / 2,
        y: 132 + 178 / 2,
        capture_id: "cap-1",
        delivery_mode: "background",
      });
      expect(clicks[0]!.args.element_token).toBeUndefined();
      // The mission looked again after acting.
      const clickIndex = calls.findIndex((call) => call.tool === "click");
      expect(calls.slice(clickIndex + 1).some((call) => call.tool === "get_window_state")).toBe(
        true,
      );
    }),
  );

  it.effect("recaptures after a refused capture and never clicks unbound", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        {
          windowState: (index, args) =>
            chromeOnly(`s${index}`, args.include_screenshot === true ? `cap-${index}` : undefined),
          parse: (args) => ok(visualResult(String(args.capture_id))),
          click: (index) => (index === 0 ? driverError("capture_expired") : ok()),
        },
        [{ action: "click", name: "Send" }, { action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("done");
      const clicks = tools(calls, "click");
      expect(clicks).toHaveLength(2);
      expect(clicks.every((call) => typeof call.args.capture_id === "string")).toBe(true);
      expect(clicks[0]!.args.capture_id).not.toBe(clicks[1]!.args.capture_id);
      // The second click is bound to a capture parsed after the refusal.
      const refusedAt = calls.indexOf(clicks[0]!);
      const reparsed = calls
        .slice(refusedAt + 1)
        .find((call) => call.tool === "parse_visual_regions");
      expect(reparsed?.args.capture_id).toBe(clicks[1]!.args.capture_id);
    }),
  );

  it.effect("lets one capture authorize at most one click", () =>
    Effect.gen(function* () {
      const { calls } = yield* runMission(
        {
          // A driver that kept handing back the same capture id.
          windowState: (index, args) =>
            chromeOnly(`s${index}`, args.include_screenshot === true ? "cap-same" : undefined),
          parse: (args) => ok(visualResult(String(args.capture_id))),
        },
        [{ action: "click", name: "Send" }, { action: "click", name: "Save" }, { action: "done" }],
      );
      const clicks = tools(calls, "click");
      expect(clicks.filter((call) => call.args.capture_id === "cap-same")).toHaveLength(1);
      expect(clicks.every((call) => call.args.capture_id !== undefined)).toBe(true);
    }),
  );

  it.effect("rejects a visual result for another window and never acts on it", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        {
          windowState: (index, args) =>
            chromeOnly(`s${index}`, args.include_screenshot === true ? `cap-${index}` : undefined),
          parse: (args) => ok(visualResult(String(args.capture_id), { pid: 99, window_id: 3 })),
        },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).not.toBe("done");
      expect(tools(calls, "click")).toHaveLength(0);
    }),
  );

  it.effect("refuses to act when the driver observes a different window", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        { windowState: (index) => ({ ...withButton(`s${index}`, "Send"), pid: 99 }) },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("refused");
      expect(tools(calls, "click")).toHaveLength(0);
    }),
  );

  it.effect("prefers the native element when perception could also see it", () =>
    Effect.gen(function* () {
      const { calls } = yield* runMission(
        {
          windowState: (index) => withButton(`s${index}`, "Send"),
          parse: (args) => ok(visualResult(String(args.capture_id))),
        },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(tools(calls, "parse_visual_regions")).toHaveLength(0);
      expect(tools(calls, "click")[0]!.args.element_token).toBe("s0:1");
    }),
  );

  it.effect("looks closer only for the step that needed it", () =>
    Effect.gen(function* () {
      // The accessible tree has a button, but not the one the goal names.
      const { result, calls } = yield* runMission(
        {
          windowState: (index, args) => ({
            ...withButton(`s${index}`, "Other"),
            ...(args.include_screenshot === true ? { capture_id: `cap-${index}` } : {}),
            screenshot_width: 760,
            screenshot_height: 460,
          }),
          parse: (args) => ok(visualResult(String(args.capture_id))),
        },
        [{ action: "click", name: "Send" }, { action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("done");
      const clicks = tools(calls, "click");
      expect(clicks[0]!.args.capture_id).toBeDefined();
      // After the escalated click, the next observation is native again.
      const afterClick = calls.slice(calls.indexOf(clicks[0]!) + 1);
      const nextObservation = afterClick.find((call) => call.tool === "get_window_state");
      expect(nextObservation?.args.include_screenshot).toBe(false);
      // Every parse was requested by an escalation that found no native target.
      expect(tools(calls, "parse_visual_regions").length).toBe(clicks.length);
    }),
  );

  it.effect("reobserves a truncated tree with a larger budget before judging it", () =>
    Effect.gen(function* () {
      const { calls } = yield* runMission(
        {
          windowState: (index) =>
            index === 0
              ? withButton("s0", "Send", { truncated: true, elements_complete: false })
              : withButton(`s${index}`, "Send"),
          parse: (args) => ok(visualResult(String(args.capture_id))),
        },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      const observations = tools(calls, "get_window_state");
      expect(observations[1]!.args).toMatchObject({
        include_screenshot: false,
        timeout_ms: 5_000,
        max_elements: 20_000,
      });
      expect(tools(calls, "parse_visual_regions")).toHaveLength(0);
      expect(tools(calls, "click")[0]!.args.element_token).toBe("s1:1");
    }),
  );

  it.effect("uses vision when accessibility still times out after the larger read budget", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        {
          windowState: (index, args) => ({
            ...chromeOnly(
              `s${index}`,
              args.include_screenshot === true ? `cap-${index}` : undefined,
            ),
            truncated: true,
            truncation_reason: "atspi_walk_timed_out",
          }),
          parse: (args) => ok(visualResult(String(args.capture_id))),
        },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("done");
      const observations = tools(calls, "get_window_state");
      expect(observations[1]!.args.timeout_ms).toBe(5_000);
      expect(observations[2]!.args.include_screenshot).toBe(true);
      expect(tools(calls, "parse_visual_regions")[0]!.args.capture_id).toBe("cap-2");
      expect(tools(calls, "click")[0]!.args.capture_id).toBe("cap-2");
    }),
  );

  it.effect("checks the screen when native controls cannot prove the final result", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        {
          windowState: (index, args) => ({
            ...withButton(`s${index}`, "Send"),
            ...(args.include_screenshot === true ? { capture_id: `cap-${index}` } : {}),
            screenshot_width: 760,
            screenshot_height: 460,
          }),
          parse: (args) => ok(visualResult(String(args.capture_id))),
        },
        [{ action: "click", name: "Send" }, { action: "done" }],
        {
          verify: (state) => JSON.stringify(state).includes('"source":"visual"'),
        },
      );
      expect(result.status).toBe("done");
      expect(tools(calls, "click")).toHaveLength(1);
      expect(tools(calls, "parse_visual_regions")).toHaveLength(1);
    }),
  );

  it.effect("reports a typed limitation when a visual-only window has no perception", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        {
          visualGrounding: false,
          windowState: (index) => chromeOnly(`s${index}`, undefined),
        },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("unavailable");
      expect(result.message).toMatch(/reading the screen is unavailable/);
      expect(tools(calls, "parse_visual_regions")).toHaveLength(0);
      expect(tools(calls, "click")).toHaveLength(0);
    }),
  );

  it.effect("treats a missing perception extension as the same limitation", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        {
          windowState: (index, args) =>
            chromeOnly(`s${index}`, args.include_screenshot === true ? `cap-${index}` : undefined),
        },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("unavailable");
      expect(tools(calls, "click")).toHaveLength(0);
    }),
  );

  it.effect("keeps native grounding working without perception", () =>
    Effect.gen(function* () {
      const { result, calls } = yield* runMission(
        { visualGrounding: false, windowState: (index) => withButton(`s${index}`, "Send") },
        [{ action: "click", name: "Send" }, { action: "done" }],
      );
      expect(result.status).toBe("done");
      expect(tools(calls, "click")[0]!.args.element_token).toBe("s0:1");
    }),
  );

  it.effect("never types into a region read from pixels", () =>
    Effect.gen(function* () {
      const { calls } = yield* runMission(
        {
          windowState: (index, args) =>
            chromeOnly(`s${index}`, args.include_screenshot === true ? `cap-${index}` : undefined),
          parse: (args) => ok(visualResult(String(args.capture_id))),
        },
        [{ action: "type", name: "Send" }],
        { goal: 'type "hello" into Send in Canvas' },
      );
      expect(tools(calls, "type_text")).toHaveLength(0);
      expect(tools(calls, "click")).toHaveLength(0);
    }),
  );

  describe("a stop sends no later input", () => {
    const visualScript = (stopOn: string): Script => ({
      windowState: (index, args) =>
        chromeOnly(`s${index}`, args.include_screenshot === true ? `cap-${index}` : undefined),
      parse: (args) => ok(visualResult(String(args.capture_id))),
      before: (tool, cancellation) =>
        tool === stopOn ? cancellation.requestStop("req-1").pipe(Effect.asVoid) : Effect.void,
    });
    const inputs = (calls: ReadonlyArray<Call>) =>
      calls.filter((call) =>
        ["click", "type_text", "press_key", "scroll", "hotkey"].includes(call.tool),
      );

    for (const phase of ["get_window_state", "parse_visual_regions"]) {
      it.effect(`during ${phase}`, () =>
        Effect.gen(function* () {
          const { result, calls } = yield* runMission(
            visualScript(phase),
            [
              { action: "click", name: "Send" },
              { action: "click", name: "Save" },
            ],
            { requestId: "req-1" },
          );
          expect(result.status).toBe("cancelled");
          expect(inputs(calls)).toHaveLength(0);
        }),
      );
    }

    it.effect("during the decision", () =>
      Effect.gen(function* () {
        const { result, calls } = yield* runMission(
          visualScript("none"),
          [
            { action: "click", name: "Send" },
            { action: "click", name: "Save" },
          ],
          {
            requestId: "req-1",
            beforeDecision: (cancellation) => cancellation.requestStop("req-1").pipe(Effect.asVoid),
          },
        );
        expect(result.status).toBe("cancelled");
        expect(inputs(calls)).toHaveLength(0);
      }),
    );

    it.effect("during the input itself", () =>
      Effect.gen(function* () {
        const { result, calls } = yield* runMission(
          visualScript("click"),
          [
            { action: "click", name: "Send" },
            { action: "click", name: "Save" },
          ],
          { requestId: "req-1" },
        );
        expect(result.status).toBe("cancelled");
        expect(inputs(calls)).toHaveLength(1);
      }),
    );
  });
});
