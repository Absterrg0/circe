// @effect-diagnostics nodeBuiltinImport:off - the test spawns a real host process and owns
// its stdout stream.
// @effect-diagnostics globalTimers:off - the host-readiness deadline is real wall-clock time
// around a child process, not Effect scheduling.
// @effect-diagnostics globalDateInEffect:off - the same wall-clock deadline measures real time.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ComputerHostBootstrap } from "@circe/contracts";

import { ComputerService, layerTest } from "./ComputerService.ts";

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
