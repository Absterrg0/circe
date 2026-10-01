// @effect-diagnostics nodeBuiltinImport:off - the test spawns a real host process and owns it.
// @effect-diagnostics globalTimers:off - the host-readiness deadline is real wall-clock time.
// @effect-diagnostics globalDateInEffect:off - the same wall-clock deadline measures real time.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ComputerHostBootstrap } from "@circe/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ComputerService, layerTest } from "../../computer/ComputerService.ts";
import { readWindows } from "../../computer/driverSchemas.ts";
import { loadCirceCore, type DesktopOutcome } from "../host/core.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import {
  CirceDesktopPlanUnavailable,
  CirceRecoveryPlanner,
} from "../Services/CirceRecoveryPlanner.ts";
import { CirceMissionCancellationLive } from "./CirceMissionCancellation.ts";
import { make } from "./CirceComputerUse.ts";

/**
 * Whole desktop goals against the real Cua driver and live Jev: a spawned
 * desktop host owns the OS session, circe-core grounds and chooses, and the
 * real window is read back. Plans are supplied the way a chat model passes
 * them to computer_do. Opt in with CIRCE_DESKTOP_GOAL_LIVE=1 on a graphical
 * session with a TypeSafe key; each goal closes only windows it opened.
 */

const live = process.env.CIRCE_DESKTOP_GOAL_LIVE === "1";
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const HOST_ENTRY = NodePath.join(
  import.meta.dirname,
  "../../../../desktop/src/computer/ComputerHost.liveEntry.ts",
);

const startHostProcess = (): Promise<{
  bootstrap: ComputerHostBootstrap;
  child: NodeChildProcess.ChildProcess;
}> => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--experimental-strip-types", HOST_ENTRY],
    {
      stdio: ["ignore", "pipe", "inherit"],
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
      resolve({ bootstrap: JSON.parse(buffer.slice(0, index)) as ComputerHostBootstrap, child });
    });
    child.once("exit", (code) =>
      reject(new Error(`The desktop host exited early with code ${code}.`)),
    );
  });
};

const stopHostProcess = (child: NodeChildProcess.ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });

interface LiveGoal {
  readonly goal: string;
  readonly plan?: unknown;
  readonly app: string;
  /** Leave the app open for the next goal instead of closing what this goal opened. */
  readonly keepOpen?: boolean;
  readonly expectStatus?: DesktopOutcome["status"];
}

const GOALS: ReadonlyArray<LiveGoal> = [
  {
    goal: "work out twelve times seven in the calculator",
    app: "Calculator",
    keepOpen: true,
    plan: {
      steps: [
        { verb: "fill", intent: "enter the product", target: { role: "text box" }, text: "12*7" },
        { verb: "click", intent: "calculate", target: { role: "button", name: "=" } },
      ],
      done: { shows: "84" },
    },
  },
  {
    goal: "what's one hundred and forty four divided by twelve on the calculator",
    app: "Calculator",
    plan: {
      steps: [
        {
          verb: "fill",
          intent: "enter the division",
          target: { role: "text box", name: "expression" },
          text: "144/12",
        },
        {
          verb: "click",
          intent: "calculate",
          target: { role: "button", description: "Calculate Result" },
        },
      ],
      done: { shows: "12" },
    },
  },
  {
    goal: "search for heart in Characters",
    app: "Characters",
    plan: {
      steps: [
        { verb: "click", intent: "open search", target: { role: "toggle button", name: "Search" } },
        { verb: "fill", intent: "search", target: { role: "search box" }, text: "heart" },
      ],
      done: { shows: "heart", in: { role: "search box" } },
    },
  },
];

describe.skipIf(!live)("Circe desktop goals, live", () => {
  it.live(
    "carries out varied goals through circe-core with live Jev and the real driver",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const core = yield* Effect.promise(loadCirceCore);
          if (core?.runDesktopGoal === undefined)
            throw new Error("circe-core 0.4 is not installed");
          const running = yield* Effect.acquireRelease(
            Effect.promise(() => startHostProcess()),
            ({ child }) => Effect.promise(() => stopHostProcess(child)),
          );
          const stateDir = yield* Effect.acquireRelease(
            Effect.promise(() =>
              NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-goal-live-")),
            ),
            (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
          );
          const direct = core.httpJev();
          const planner = Layer.mock(CirceRecoveryPlanner)({
            planDesktop: () =>
              Effect.fail(
                new CirceDesktopPlanUnavailable({ reason: "plans are supplied in this test" }),
              ),
          });
          const serviceLayer = layerTest({ stateDir, computerHost: running.bootstrap }).pipe(
            Layer.provide(NodeServices.layer),
          );
          const layer = Layer.effect(
            CirceComputerUse,
            make({
              desktop: Effect.succeed({
                runDesktopGoal: core.runDesktopGoal,
                jev: {
                  ask: async (request) => {
                    const response = await direct.ask(request);
                    const out = process.env.CIRCE_DESKTOP_GOAL_LIVE_OUT;
                    if (out !== undefined)
                      await NodeFSP.appendFile(
                        out,
                        `${JSON.stringify({ jev: Object.keys(request.questions), answers: response.answers, latencyMs: Math.round(response.latencyMs) })}\n`,
                      );
                    return response;
                  },
                },
              }),
            }),
          ).pipe(
            Layer.provideMerge(serviceLayer),
            Layer.provide(planner),
            Layer.provide(CirceMissionCancellationLive),
          );

          yield* Effect.gen(function* () {
            const service = yield* ComputerService;
            yield* service.events.pipe(
              Stream.filter((event) => event.type === "host-state" && event.state === "connected"),
              Stream.take(1),
              Stream.runDrain,
              Effect.timeout("30 seconds"),
            );
            const executor = yield* CirceComputerUse;
            const windowsNow = Effect.gen(function* () {
              const mission = yield* service.beginMission({
                goal: "list windows",
                source: "ui",
                owner: { kind: "client" },
              });
              const listed = yield* service.call({
                missionId: mission.id,
                tool: "list_windows",
                args: { on_screen_only: true },
              });
              yield* service.endMission({ missionId: mission.id, reason: "listed" });
              return readWindows(listed.structured);
            });
            const opened = new Set<number>();
            const closeOpened = Effect.sync(() => {
              for (const pid of opened) process.kill(pid, "SIGTERM");
              opened.clear();
            });
            yield* Effect.gen(function* () {
              for (const entry of GOALS) {
                const before = new Set((yield* windowsNow).map((window) => window.pid));
                let finished: DesktopOutcome | undefined;
                const mission = yield* service.beginMission({
                  goal: entry.goal,
                  source: "ui",
                  owner: { kind: "client" },
                });
                const result = yield* executor
                  .runInMission(mission, {
                    goal: entry.goal,
                    stopped: Effect.succeed(false),
                    ...(entry.plan === undefined ? {} : { plan: entry.plan }),
                    onFinished: (outcome) => {
                      finished = outcome;
                    },
                  })
                  .pipe(
                    Effect.ensuring(service.endMission({ missionId: mission.id, reason: "done" })),
                  );
                // Only processes that were not there before this goal and are the app it used.
                for (const window of yield* windowsNow) {
                  if (before.has(window.pid)) continue;
                  const commandLine = yield* Effect.promise(() =>
                    NodeFSP.readFile(`/proc/${window.pid}/cmdline`, "utf8").catch(() => ""),
                  );
                  const wanted = entry.app.toLowerCase();
                  if (
                    window.app_name.toLowerCase().includes(wanted) ||
                    commandLine.toLowerCase().includes(wanted)
                  )
                    opened.add(window.pid);
                }
                const record = {
                  goal: entry.goal,
                  result,
                  metrics: finished?.metrics,
                  trace: finished?.trace,
                };
                const out = process.env.CIRCE_DESKTOP_GOAL_LIVE_OUT;
                if (out !== undefined) {
                  const recordJson = yield* encodeRecord(record);
                  yield* Effect.promise(() => NodeFSP.appendFile(out, `${recordJson}\n`));
                }
                expect(finished?.status).toBe(entry.expectStatus ?? "done");
                if (entry.keepOpen !== true) yield* closeOpened;
              }
            }).pipe(Effect.ensuring(closeOpened));
          }).pipe(Effect.provide(layer));
        }),
      ),
    180_000,
  );
});
