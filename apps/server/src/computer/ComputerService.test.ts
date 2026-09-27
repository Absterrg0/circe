// @effect-diagnostics nodeBuiltinImport:off - the test owns real temp directories and audit
// files; Effect FileSystem is exercised in production code, not in the harness.
// @effect-diagnostics preferSchemaOverJson:off - the test reads raw JSONL audit lines.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import {
  ComputerMissionError,
  ComputerService,
  ComputerUnavailableError,
  layerTest,
} from "./ComputerService.ts";
import { startFakeHost, type FakeHostServer } from "./ComputerHostTestkit.testkit.ts";

interface HostContext {
  readonly host: FakeHostServer;
  readonly stateDir: string;
}

const withHost = <A, E, R>(run: (context: HostContext) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(async () => {
        const host = await startFakeHost();
        const stateDir = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "circe-computer-service-"),
        );
        return { host, stateDir } satisfies HostContext;
      }),
      ({ host, stateDir }) =>
        Effect.promise(async () => {
          await host.close();
          await NodeFSP.rm(stateDir, { recursive: true, force: true });
        }),
    ).pipe(Effect.flatMap(run)),
  );

const serviceLayer = (context: HostContext) =>
  layerTest({ stateDir: context.stateDir, computerHost: context.host.bootstrap }).pipe(
    Layer.provide(NodeServices.layer),
  );

const waitFor = (check: () => boolean, timeoutMs = 3_000) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    while (!check()) {
      if ((yield* Clock.currentTimeMillis) - started > timeoutMs)
        return yield* Effect.die(new Error("Condition never became true"));
      yield* Effect.sleep("5 millis");
    }
  });

describe("ComputerService", () => {
  it.live("runs a mission, audits calls, and reports status", () =>
    withHost((context) =>
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* waitFor(() => context.host.hellos.length === 1);

        const status = yield* service.status;
        expect(status.available).toBe(true);

        const mission = yield* service.beginMission({
          goal: "open settings",
          source: "ui",
          owner: { kind: "client" },
        });
        expect(mission.id.length).toBeGreaterThan(0);
        const result = yield* service.call({
          missionId: mission.id,
          tool: "list_windows",
          args: {},
        });
        expect(result.effect).toBe("verified");

        const active = yield* service.activeMission;
        expect(active?.id).toBe(mission.id);

        const auditLines = (yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(context.stateDir, "computer-audit.jsonl"), "utf8"),
        ))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(auditLines.map((line) => line.event)).toEqual(["mission.begin", "call"]);
        expect(auditLines[1]).toMatchObject({
          missionId: mission.id,
          tool: "list_windows",
          effect: "verified",
        });
        expect(JSON.stringify(auditLines)).not.toContain("open settings");
      }).pipe(Effect.provide(serviceLayer(context))),
    ),
  );

  it.live("refuses calls without an active mission and a second mission", () =>
    withHost((context) =>
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* waitFor(() => context.host.hellos.length === 1);
        const noMission = yield* Effect.flip(
          service.call({ missionId: "missing", tool: "list_windows" }),
        );
        expect(noMission).toBeInstanceOf(ComputerMissionError);
        const mission = yield* service.beginMission({
          goal: "one",
          source: "voice",
          owner: { kind: "client" },
        });
        const conflict = yield* Effect.flip(
          service.beginMission({ goal: "two", source: "voice", owner: { kind: "client" } }),
        );
        expect(conflict).toBeInstanceOf(ComputerMissionError);
        const wrongMission = yield* Effect.flip(
          service.call({ missionId: "other", tool: "list_windows" }),
        );
        expect(wrongMission).toBeInstanceOf(ComputerMissionError);
        yield* service.endMission({ missionId: mission.id, reason: "test" });
        expect(yield* service.activeMission).toBeUndefined();
      }).pipe(Effect.provide(serviceLayer(context))),
    ),
  );

  it.live("ends the mission on a driver-exit event and stops input on request", () =>
    withHost((context) =>
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* waitFor(() => context.host.hellos.length === 1);
        const mission = yield* service.beginMission({
          goal: "one",
          source: "ui",
          owner: { kind: "client" },
        });
        context.host.pushEvent({ event: "driver-exit", missionId: mission.id });
        yield* waitFor(() =>
          context.host.requests.some((request) => request.method === "end-mission"),
        );
        expect(yield* service.activeMission).toBeUndefined();

        const second = yield* service.beginMission({
          goal: "two",
          source: "ui",
          owner: { kind: "client" },
        });
        yield* service.stop(second.id);
        expect(context.host.requests.some((request) => request.method === "stop")).toBe(true);
        expect(yield* service.activeMission).toBeUndefined();
      }).pipe(Effect.provide(serviceLayer(context))),
    ),
  );

  it.live("admits exactly one of two concurrent starts", () =>
    withHost((context) =>
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* waitFor(() => context.host.hellos.length === 1);
        context.host.setBeginDelay(150);
        const [first, second] = yield* Effect.all(
          [
            Effect.result(
              service.beginMission({ goal: "A", source: "voice", owner: { kind: "client" } }),
            ),
            Effect.result(
              service.beginMission({ goal: "B", source: "voice", owner: { kind: "client" } }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const outcomes = [first, second];
        expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toHaveLength(1);
        expect(yield* service.activeMission).toBeDefined();
      }).pipe(Effect.provide(serviceLayer(context))),
    ),
  );

  it.live("releases the slot and reconciles the host when a start is interrupted", () =>
    withHost((context) =>
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* waitFor(() => context.host.hellos.length === 1);
        context.host.setBeginDelay(500);
        const fiber = yield* Effect.forkChild(
          Effect.result(
            service.beginMission({
              goal: "interrupted",
              source: "voice",
              owner: { kind: "client" },
            }),
          ),
        );
        yield* waitFor(() =>
          context.host.requests.some((request) => request.method === "begin-mission"),
        );
        yield* Fiber.interrupt(fiber);
        // The interrupted admission is reconciled at the host, and the slot is
        // free for the next start.
        yield* waitFor(() =>
          context.host.requests.some((request) => request.method === "end-mission"),
        );
        expect(yield* service.activeMission).toBeUndefined();
        context.host.setBeginDelay(0);
        const mission = yield* service.beginMission({
          goal: "next",
          source: "voice",
          owner: { kind: "client" },
        });
        expect(mission.goal).toBe("next");
      }).pipe(Effect.provide(serviceLayer(context))),
    ),
  );

  it.live("refuses a provider call under a client-owned mission", () =>
    withHost((context) =>
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* waitFor(() => context.host.hellos.length === 1);
        const mission = yield* service.beginMission({
          goal: "user mission",
          source: "voice",
          owner: { kind: "client" },
        });
        const error = yield* Effect.flip(
          service.call({
            missionId: mission.id,
            tool: "list_windows",
            args: {},
            owner: { kind: "provider", threadId: "thread-b", providerSessionId: "session-b" },
          }),
        );
        expect(error).toBeInstanceOf(ComputerMissionError);
      }).pipe(Effect.provide(serviceLayer(context))),
    ),
  );

  it.live("surfaces a host mission conflict", () =>
    withHost((context) =>
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* waitFor(() => context.host.hellos.length === 1);
        context.host.setBeginConflict(true);
        const error = yield* Effect.flip(
          service.beginMission({ goal: "x", source: "ui", owner: { kind: "client" } }),
        );
        expect(error).toBeInstanceOf(ComputerMissionError);
        // The slot is released, so a later start can succeed.
        context.host.setBeginConflict(false);
        const mission = yield* service.beginMission({
          goal: "y",
          source: "ui",
          owner: { kind: "client" },
        });
        expect(mission.id.length).toBeGreaterThan(0);
      }).pipe(Effect.provide(serviceLayer(context))),
    ),
  );

  it.live("keeps the slot busy until the host acknowledges end-of-mission", () =>
    withHost((context) =>
      Effect.gen(function* () {
        const service = yield* ComputerService;
        yield* waitFor(() => context.host.hellos.length === 1);
        const mission = yield* service.beginMission({
          goal: "one",
          source: "ui",
          owner: { kind: "client" },
        });
        yield* service.endMission({ missionId: mission.id, reason: "test" });
        expect(yield* service.activeMission).toBeUndefined();
        expect(context.host.requests.some((request) => request.method === "end-mission")).toBe(
          true,
        );
        const auditLines = (yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(context.stateDir, "computer-audit.jsonl"), "utf8"),
        ))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const end = auditLines.find((line) => line.event === "mission.end");
        expect(end).toMatchObject({ missionId: mission.id, settled: true });
      }).pipe(Effect.provide(serviceLayer(context))),
    ),
  );

  it.live("reports unavailable when the node has no host", () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-computer-no-host-")),
      );
      const program = Effect.gen(function* () {
        const service = yield* ComputerService;
        const status = yield* service.status;
        expect(status.available).toBe(false);
        const error = yield* Effect.flip(
          service.beginMission({ goal: "x", source: "ui", owner: { kind: "client" } }),
        );
        expect(error).toBeInstanceOf(ComputerUnavailableError);
      }).pipe(
        Effect.provide(
          layerTest({ stateDir, computerHost: undefined }).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      yield* program;
      yield* Effect.promise(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
    }),
  );
});
