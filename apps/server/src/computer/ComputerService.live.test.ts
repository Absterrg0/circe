// @effect-diagnostics nodeBuiltinImport:off - the test spawns a real host process and owns
// its stdout stream.
// @effect-diagnostics globalTimers:off - the host-readiness deadline is real wall-clock time
// around a child process, not Effect scheduling.
// @effect-diagnostics globalDateInEffect:off - the same wall-clock deadline measures real time.
import { CirceComputerUse } from "../circe/Services/CirceComputerUse.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ComputerHostBootstrap,
} from "@circe/contracts";

import { ComputerService, layerTest } from "./ComputerService.ts";
import { readWindows } from "./driverSchemas.ts";
import { clickArguments, observeGrounded } from "./grounding.ts";
import { make as makeComputerToolkit } from "../mcp/toolkits/computer/handlers.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { CirceComputerAccess } from "../circe/Services/CirceComputerAccess.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";

/**
 * End-to-end live check against the real Cua driver: a spawned desktop host
 * owns the runtime and OS session, and this service connects over the same
 * authenticated socket the app uses. Opt in with CIRCE_COMPUTER_LIVE_TEST=1;
 * it needs a graphical session and cannot run on headless CI.
 */

const live = process.env.CIRCE_COMPUTER_LIVE_TEST === "1";
const HOST_ENTRY = NodePath.join(
  import.meta.dirname,
  "../../../desktop/src/computer/ComputerHost.liveEntry.ts",
);

const startHostProcess = async (): Promise<{
  readonly bootstrap: ComputerHostBootstrap;
  readonly child: NodeChildProcess.ChildProcess;
}> => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--experimental-strip-types", HOST_ENTRY],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The desktop host did not print a bootstrap in 30s."));
    }, 30_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      const line = buffer.slice(0, index);
      try {
        resolve({ bootstrap: JSON.parse(line) as ComputerHostBootstrap, child });
      } catch (error) {
        child.kill("SIGKILL");
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The desktop host exited early with code ${code}.`));
    });
  });
};

const stopHostProcess = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

describe.skipIf(!live)("ComputerService live host", () => {
  it.live.skipIf(process.env.CIRCE_COMPUTER_LIVE_CALCULATOR !== "1")(
    "launches and calculates through the provider toolkit in two consecutive missions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Effect.acquireRelease(
            Effect.promise(() => startHostProcess()),
            ({ child }) => Effect.promise(() => stopHostProcess(child)),
          );
          const stateDir = yield* Effect.acquireRelease(
            Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-provider-live-")),
            ),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          yield* Effect.gen(function* () {
            const service = yield* ComputerService;
            const toolkit = yield* makeComputerToolkit;
            const connected = yield* service.events.pipe(
              Stream.filter((event) => event.type === "host-state" && event.state === "connected"),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkChild,
            );
            if (!(yield* service.status).available)
              yield* Fiber.join(connected).pipe(Effect.timeout("10 seconds"));
            for (let attempt = 0; attempt < 2; attempt += 1) {
              const start = Date.now();
              const mission = yield* service.beginMission({
                goal: "Open Calculator and calculate 50 plus 3",
                source: "ui",
                owner: {
                  kind: "provider",
                  threadId: "live-thread",
                  providerSessionId: "live-session",
                },
              });
              yield* Effect.gen(function* () {
                const apps = yield* toolkit.computer_list_apps({ query: "Calculator" });
                const app = apps.apps.find((app) => app.name === "Calculator");
                expect(app?.launchPath).toBeTruthy();
                const launch = yield* toolkit.computer_launch_app({ launchPath: app!.launchPath });
                expect(launch.windows.length).toBeGreaterThan(0);
                const target = launch.windows.find((window) => window.pid === launch.pid)!;
                expect(target).toBeDefined();
                expect(Date.now() - start).toBeLessThan(8_000);
                yield* Effect.gen(function* () {
                  const state = yield* toolkit.computer_window_state(target);
                  const entry = state.controls.find((control) => control.role === "text box");
                  expect(entry).toBeDefined();
                  const typed = yield* toolkit.computer_type({
                    text: "50+3",
                    controlId: entry!.controlId,
                  });
                  expect(typed.refusalCode).toBeUndefined();
                  expect(typed.windowState).toBeDefined();
                  const typedState = typed.windowState!;
                  expect(typedState.controls.some((control) => control.value === "50+3")).toBe(
                    true,
                  );
                  const equals = typedState.controls.find(
                    (control) => control.name === "=" && control.role === "button",
                  );
                  expect(equals).toBeDefined();
                  const clicked = yield* toolkit.computer_click({ controlId: equals!.controlId });
                  expect(clicked.refusalCode).toBeUndefined();
                  expect(clicked.windowState).toBeDefined();
                  const clickedState = clicked.windowState!;
                  expect(clickedState.controls.some((control) => control.value === "53")).toBe(
                    true,
                  );
                  yield* Effect.logInfo("provider calculator acceptance", {
                    attempt: attempt + 1,
                    elapsedMs: Date.now() - start,
                    pid: target.pid,
                    windowId: target.windowId,
                    result: "53",
                  }).pipe(
                    Effect.provide(Logger.layer([Logger.consoleJson])),
                    Effect.provideService(References.MinimumLogLevel, "Info"),
                  );
                }).pipe(
                  Effect.ensuring(
                    Effect.gen(function* () {
                      const state = yield* toolkit.computer_window_state(target);
                      const close = state.controls.find((control) => control.name === "Close");
                      expect(close).toBeDefined();
                      yield* toolkit.computer_click({ controlId: close!.controlId });
                      const remaining = yield* toolkit.computer_list_windows({
                        pid: target.pid,
                        all: true,
                      });
                      expect(remaining.windows).toHaveLength(0);
                    }).pipe(Effect.orDie),
                  ),
                );
              }).pipe(
                Effect.ensuring(service.endMission({ missionId: mission.id, reason: "done" })),
              );
            }
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(CirceComputerUse)({ wholeGoals: false }),
                layerTest({ stateDir, computerHost: running.bootstrap }).pipe(
                  Layer.provide(NodeServices.layer),
                ),
                Layer.mock(CirceComputerAccess)({
                  controllable: true,
                  holds: () => Effect.succeed(true),
                }),
                Layer.mock(OrchestratorV2)({ getThreadShell: () => Effect.succeed(null) }),
                Layer.succeed(McpInvocationContext, {
                  environmentId: EnvironmentId.make("live-env"),
                  threadId: ThreadId.make("live-thread"),
                  providerSessionId: "live-session",
                  providerInstanceId: ProviderInstanceId.make("opencode"),
                  capabilities: new Set(["computer-use" as const]),
                  issuedAt: 0,
                }),
              ),
            ),
          );
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "connects to a real desktop host, runs a mission, and audits it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Effect.acquireRelease(
            Effect.promise(() => startHostProcess()),
            ({ child }) => Effect.promise(() => stopHostProcess(child)),
          );
          const stateDir = yield* Effect.acquireRelease(
            Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-computer-live-service-")),
            ),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );

          yield* Effect.gen(function* () {
            const service = yield* ComputerService;
            const deadline = Date.now() + 10_000;
            let status = yield* service.status;
            while (!status.available && Date.now() < deadline) {
              yield* Effect.sleep("100 millis");
              status = yield* service.status;
            }
            expect(status.available).toBe(true);
            expect(status.host?.runtime).toBeDefined();

            const mission = yield* service.beginMission({
              goal: "list the windows on this desktop",
              source: "ui",
              owner: { kind: "client" },
            });
            const windows = yield* service.call({
              missionId: mission.id,
              tool: "list_windows",
              args: {},
            });
            expect(windows.isError).toBe(false);
            expect(Array.isArray((windows.structured as { windows?: unknown[] })?.windows)).toBe(
              true,
            );
            yield* service.endMission({ missionId: mission.id, reason: "done" });
            expect(yield* service.activeMission).toBeUndefined();
          }).pipe(
            Effect.provide(
              layerTest({ stateDir, computerHost: running.bootstrap }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
          );

          const audit = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(stateDir, "computer-audit.jsonl"), "utf8"),
          );
          expect(audit).toContain("mission.begin");
          expect(audit).toContain("list_windows");
          expect(audit).toContain("mission.end");
        }),
      ),
    { timeout: 60_000 },
  );
});

/**
 * Native and visual grounding against real fixture windows on this desktop.
 * Opt in with CIRCE_COMPUTER_LIVE_GROUNDING=1 after starting Cua's GTK3
 * harness ("CuaTestHarness GTK3") and visual-only canvas fixture ("Circe
 * Visual Fixture", journaling to CIRCE_LIVE_VISUAL_JOURNAL) under X11, with
 * CIRCE_LIVE_CUA_HOME holding an installed perception extension.
 */
const grounding = live && process.env.CIRCE_COMPUTER_LIVE_GROUNDING === "1";

describe.skipIf(!grounding)("ComputerService live grounding", () => {
  it.live(
    "acts natively on an accessible window and through a capture on a painted one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* Effect.acquireRelease(
            Effect.promise(() => startHostProcess()),
            ({ child }) => Effect.promise(() => stopHostProcess(child)),
          );
          const stateDir = yield* Effect.acquireRelease(
            Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-computer-live-grounding-")),
            ),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          yield* Effect.gen(function* () {
            const service = yield* ComputerService;
            const deadline = Date.now() + 10_000;
            while (!(yield* service.status).available && Date.now() < deadline)
              yield* Effect.sleep("100 millis");
            const mission = yield* service.beginMission({
              goal: "live grounding",
              source: "ui",
              owner: { kind: "client" },
            });
            const call = (tool: string, args: Record<string, unknown>) =>
              service.call({ missionId: mission.id, tool, args });
            const windows = readWindows((yield* call("list_windows", {})).structured);
            const find = (title: string) => {
              const window = windows.find((entry) => entry.title === title);
              if (window === undefined) throw new Error(`no window titled ${title}`);
              return { pid: window.pid, windowId: window.window_id };
            };
            let status = yield* service.status;
            if (process.env.CIRCE_LIVE_PERCEPTION_CATALOG !== undefined) {
              // First-use acceptance includes the real signed download and
              // install. This deadline is external process time, not test time.
              const provisionDeadline = Date.now() + 120_000;
              while (
                status.host?.capabilities.visualGrounding !== true &&
                Date.now() < provisionDeadline
              ) {
                yield* Effect.sleep("100 millis");
                status = yield* service.status;
              }
            }
            expect(status.host?.capabilities.visualGrounding).toBe(true);

            // Native: the accessible button is grounded by token; nothing is parsed.
            // The counter label is not an actionable element, so the screen is
            // read before and after; a read is a new snapshot, so the native
            // observation comes after it or its tokens would already be stale.
            const gtk = find("CuaTestHarness GTK3");
            const readCounter = observeGrounded({
              call,
              target: gtk,
              platform: "linux",
              visualAvailable: true,
              mode: "visual",
            }).pipe(
              Effect.map(
                (observed) =>
                  observed.elements.find((element) => /^counter\s*=\s*\d+$/.test(element.name))
                    ?.name,
              ),
            );
            const before = yield* readCounter;
            const native = yield* observeGrounded({
              call,
              target: gtk,
              platform: "linux",
              visualAvailable: true,
            });
            expect(native.report.visual).toBe("skipped");
            // The harness names its controls by accessible id.
            const increment = native.elements.find((element) => element.name === "btn-increment");
            expect(increment?.source).toBe("native");
            const clicked = yield* call(
              "click",
              clickArguments(gtk, native.executables.get(increment!.id)!),
            );
            expect(clicked.isError).toBe(false);
            const after = yield* readCounter;
            expect(before).toBeDefined();
            expect(after).not.toBe(before);

            // Visual: a painted window falls back to its capture and is clicked through it.
            const canvas = find("Circe Visual Fixture");
            // Pixel input is refused when another application covers the
            // target. Prepare only the test fixture, before taking its capture.
            const brought = yield* call("bring_to_front", {
              pid: canvas.pid,
              window_id: canvas.windowId,
            });
            expect(brought, brought.text).toMatchObject({ isError: false });
            const visual = yield* observeGrounded({
              call,
              target: canvas,
              platform: "linux",
              visualAvailable: true,
            });
            expect(visual.report.fallback).toBe("no_application_elements");
            expect(visual.report.visual).toBe("parsed");
            const send = visual.elements.find(
              (element) => element.source === "visual" && element.name.toLowerCase() === "send",
            );
            expect(send).toBeDefined();
            const executable = visual.executables.get(send!.id)!;
            expect(executable.kind).toBe("visual");
            const visualClick = yield* call("click", clickArguments(canvas, executable));
            expect(
              visualClick,
              `${visualClick.driverCode ?? visualClick.refusalCode}: ${visualClick.text}`,
            ).toMatchObject({ isError: false });
            const reused = yield* call("click", clickArguments(canvas, executable));
            expect(reused.driverCode).toBe("capture_not_found");
            const journal = process.env.CIRCE_LIVE_VISUAL_JOURNAL;
            if (journal !== undefined) {
              const lines = (yield* Effect.promise(() => NodeFSP.readFile(journal, "utf8")))
                .trim()
                .split("\n");
              const selected = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.Struct({ selected: Schema.String })),
              )(lines.at(-1));
              expect(selected).toMatchObject({ selected: "send" });
            }
            yield* Effect.logInfo("live grounding reports", {
              native: native.report,
              visual: visual.report,
              visualClickEffect: visualClick.effect,
            });
            yield* service.endMission({ missionId: mission.id, reason: "done" });
          }).pipe(
            Effect.provide(
              layerTest({ stateDir, computerHost: running.bootstrap }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
          );
        }),
      ),
    { timeout: 180_000 },
  );
});
