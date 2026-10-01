import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@circe/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CirceComputerAccess } from "../../../circe/Services/CirceComputerAccess.ts";
import {
  CirceComputerUse,
  type CirceComputerGoal,
} from "../../../circe/Services/CirceComputerUse.ts";
import { ComputerService, type ComputerMission } from "../../../computer/ComputerService.ts";
import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { make } from "./handlers.ts";
import { ComputerDoResult } from "./tools.ts";

const readDoResult = Schema.decodeUnknownSync(ComputerDoResult);

const granted: ComputerMission = {
  id: "mission-7",
  goal: "calculate 12 times 7",
  source: "agent",
  owner: { kind: "provider", threadId: "thread-1", providerSessionId: "session-1" },
  startedAtMs: 0,
};

interface Scenario {
  readonly holds?: boolean;
  readonly grant?: "granted" | "waiting" | "declined";
  readonly wholeGoals?: boolean;
  readonly mission?: ComputerMission;
  readonly activeRunId?: string | null;
  readonly unverified?: boolean;
}

/**
 * A provider session asking Circe to carry out a whole goal. Everything the
 * handler touches is recorded: which mission the executor ran in, what was
 * asked of the user, and whether any mission was begun.
 */
const harness = (scenario: Scenario) => {
  const runs: Array<{ mission: ComputerMission; goal: CirceComputerGoal }> = [];
  const requests: string[] = [];
  const begins: string[] = [];
  const calls: string[] = [];
  let held = scenario.holds ?? false;
  const layer = Layer.mergeAll(
    Layer.mock(ComputerService)({
      call: (input) =>
        Effect.sync(() => {
          calls.push(input.tool);
          return {
            isError: false,
            degraded: false,
            images: [],
            effect: "verified" as const,
            text: "Called.",
          };
        }),
      activeMission: Effect.sync(() => (held ? (scenario.mission ?? granted) : undefined)),
      beginMission: (input) =>
        Effect.sync(() => {
          begins.push(input.goal);
          return granted;
        }),
    }),
    Layer.mock(CirceComputerAccess)({
      controllable: true,
      release: () =>
        Effect.sync(() => {
          held = false;
        }),
      holds: () => Effect.sync(() => held),
      request: (input) =>
        Effect.sync(() => {
          requests.push(input.goal);
          return {
            id: "request-1",
            goal: input.goal,
            requester: input.requester,
            at: "",
            cancelId: null,
          };
        }),
      awaitGrant: () =>
        Effect.sync(() => {
          const grant = scenario.grant ?? "waiting";
          if (grant === "granted") {
            held = true;
            return { status: "granted" as const, missionId: granted.id };
          }
          return grant === "declined"
            ? { status: "declined" as const, message: "The user declined." }
            : { status: "waiting" as const, requestId: "request-1" };
        }),
    }),
    Layer.mock(CirceComputerUse)({
      wholeGoals: scenario.wholeGoals ?? true,
      runInMission: (mission, goal) =>
        Effect.sync(() => {
          runs.push({ mission, goal });
          goal.onFinished?.({
            status: scenario.unverified ? "unverified" : "done",
            said: "Done: calculate 12 times 7. Calculator shows 84.",
            actions: 2,
            metrics: {
              totalMs: 1_200,
              planner: { calls: 0, ms: 0 },
              jev: { calls: 2, ms: 600 },
              launch: { calls: 0, ms: 0 },
              observe: { calls: 4, ms: 300 },
              act: { calls: 2, ms: 250 },
              verify: { calls: 1, ms: 400 },
            },
            trace: [],
          });
          return {
            status: scenario.unverified ? ("budget" as const) : ("done" as const),
            message: "Done: calculate 12 times 7. Calculator shows 84.",
            steps: 2,
          };
        }),
    }),
    Layer.mock(OrchestratorV2)({
      getThreadShell: () =>
        Effect.succeed({
          id: ThreadId.make("thread-1"),
          title: "Do some maths",
          activeRunId:
            scenario.activeRunId === undefined ? RunId.make("run-1") : scenario.activeRunId,
        } as never),
    }),
    Layer.succeed(McpInvocationContext, {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "session-1",
      providerInstanceId: ProviderInstanceId.make("opencode"),
      capabilities: new Set(["computer-use"]) as ReadonlySet<"computer-use">,
      issuedAt: 0,
    }),
  );
  return { layer, runs, requests, begins, calls };
};

const call = (scenario: Scenario, input: { readonly goal: string; readonly plan?: never }) => {
  const test = harness(scenario);
  return Effect.gen(function* () {
    const handlers = yield* make;
    const outcome = yield* Effect.result(handlers.computer_do(input));
    return { outcome, ...test };
  }).pipe(Effect.provide(test.layer));
};

describe("computer_do", () => {
  it.effect(
    "preserves an unverified result and prevents step tools from replaying a finished goal",
    () => {
      const test = harness({ holds: true, unverified: true });
      return Effect.gen(function* () {
        const handlers = yield* make;
        const result = yield* handlers.computer_do({ goal: granted.goal });
        expect(result.status).toBe("unverified");
        expect(readDoResult(result)).toEqual(result);
        const retry = yield* Effect.result(handlers.computer_key({ key: "Return" }));
        expect(retry._tag === "Failure" && retry.failure).toMatchObject({
          code: "mission-finished",
        });
        const begin = yield* handlers.computer_begin({ goal: granted.goal });
        expect(begin.status).toBe("declined");
        expect(test.requests).toEqual([]);
        expect(test.calls).toEqual([]);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect(
    "returns a finished mission's result on a provider retry without executing again",
    () => {
      const test = harness({ holds: true });
      return Effect.gen(function* () {
        const handlers = yield* make;
        const first = yield* handlers.computer_do({ goal: granted.goal });
        const retry = yield* handlers.computer_do({ goal: granted.goal });
        expect(retry).toEqual(first);
        const changed = yield* handlers.computer_do({ goal: "calculate another expression" });
        expect(changed.status).toBe("waiting");
        expect(test.requests).toEqual(["calculate another expression"]);
        expect(test.runs).toHaveLength(1);
      }).pipe(Effect.provide(test.layer));
    },
  );

  it.effect("runs the whole goal inside the run's own granted mission, beginning none", () =>
    Effect.gen(function* () {
      const { outcome, runs, requests, begins } = yield* call(
        { holds: true },
        { goal: "calculate 12 times 7" },
      );
      expect(outcome._tag).toBe("Success");
      if (outcome._tag !== "Success") return;
      expect(outcome.success).toMatchObject({
        status: "done",
        actions: 2,
        timings: { totalMs: 1_200, plannerCalls: 0, jevCalls: 2, actionMs: 250, verifyMs: 400 },
      });
      expect(runs.map((run) => run.mission.id)).toEqual(["mission-7"]);
      expect(requests).toEqual([]);
      expect(begins).toEqual([]);
    }),
  );

  it.effect("asks the user first and runs once they approve", () =>
    Effect.gen(function* () {
      const { outcome, runs, requests } = yield* call(
        { grant: "granted" },
        { goal: "calculate 12 times 7" },
      );
      expect(outcome._tag === "Success" && outcome.success.status).toBe("done");
      expect(requests).toEqual(["calculate 12 times 7"]);
      expect(runs).toHaveLength(1);
    }),
  );

  it.effect("does nothing on the desktop while the user has not answered or declined", () =>
    Effect.gen(function* () {
      const waiting = yield* call({ grant: "waiting" }, { goal: "calculate 12 times 7" });
      expect(waiting.outcome._tag === "Success" && waiting.outcome.success.status).toBe("waiting");
      expect(waiting.runs).toEqual([]);
      const declined = yield* call({ grant: "declined" }, { goal: "calculate 12 times 7" });
      expect(declined.outcome._tag === "Success" && declined.outcome.success).toMatchObject({
        status: "declined",
        message: "The user declined.",
      });
      expect(declined.runs).toEqual([]);
    }),
  );

  it.effect("never runs a goal in a mission another session holds", () =>
    Effect.gen(function* () {
      const other: ComputerMission = {
        ...granted,
        owner: { kind: "provider", threadId: "thread-2", providerSessionId: "session-2" },
      };
      const { outcome, runs } = yield* call(
        { holds: true, mission: other },
        { goal: "calculate 12 times 7" },
      );
      expect(outcome._tag).toBe("Failure");
      expect(runs).toEqual([]);
    }),
  );

  it.effect("needs a running turn, and a node that carries out whole goals", () =>
    Effect.gen(function* () {
      const idle = yield* call(
        { holds: true, activeRunId: null },
        { goal: "calculate 12 times 7" },
      );
      expect(idle.outcome._tag === "Failure" && idle.outcome.failure).toMatchObject({
        code: "run-required",
      });
      const noCore = yield* call(
        { holds: true, wholeGoals: false },
        { goal: "calculate 12 times 7" },
      );
      expect(noCore.outcome._tag === "Success" && noCore.outcome.success.status).toBe(
        "unavailable",
      );
      expect(noCore.requests).toEqual([]);
      expect(noCore.runs).toEqual([]);
    }),
  );

  it.effect("stops the goal once the run no longer holds the computer", () =>
    Effect.gen(function* () {
      const { runs } = yield* call({ holds: true }, { goal: "calculate 12 times 7" });
      expect(yield* runs[0]!.goal.stopped).toBe(true);
    }),
  );
});
