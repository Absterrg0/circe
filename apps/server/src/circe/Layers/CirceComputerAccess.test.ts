import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type CirceComputerUseInput,
  type CirceComputerUseResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@circe/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ComputerMissionError,
  ComputerService,
  type ComputerMission,
  type ComputerServiceEvent,
} from "../../computer/ComputerService.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { McpInvocationContext } from "../../mcp/McpInvocationContext.ts";
import { make as makeComputerTools } from "../../mcp/toolkits/computer/handlers.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import {
  CirceComputerAccess,
  type CirceComputerAccessState,
  type CirceComputerAgent,
} from "../Services/CirceComputerAccess.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";
import { CirceComputerAccessLive } from "./CirceComputerAccess.ts";
import { CirceMissionCancellationLive } from "./CirceMissionCancellation.ts";

/**
 * A computer host with one mission slot, as ComputerService enforces it.
 * `admission` holds beginMission open until the test releases it.
 */
const makeComputer = Effect.gen(function* () {
  const events = yield* PubSub.unbounded<ComputerServiceEvent>();
  let mission: ComputerMission | undefined;
  const control: { admission: Deferred.Deferred<void> | null } = { admission: null };
  const end = (missionId: string, reason: string) =>
    Effect.gen(function* () {
      if (mission?.id !== missionId) return;
      mission = undefined;
      yield* PubSub.publish(events, { type: "mission-ended", missionId, reason });
    });
  const layer = Layer.mock(ComputerService)({
    status: Effect.sync(() => ({ available: true, host: undefined, activeMission: mission })),
    activeMission: Effect.sync(() => mission),
    beginMission: (input) =>
      Effect.gen(function* () {
        if (control.admission !== null) yield* Deferred.await(control.admission);
        if (mission !== undefined) {
          return yield* new ComputerMissionError({
            reason: "A computer mission is already active.",
          });
        }
        mission = {
          id: `mission-${input.goal}`,
          goal: input.goal,
          source: input.source,
          owner: input.owner,
          startedAtMs: 0,
        };
        return mission;
      }),
    call: (input) =>
      mission?.id === input.missionId &&
      JSON.stringify(mission.owner) === JSON.stringify(input.owner)
        ? Effect.succeed({
            isError: false,
            degraded: false,
            effect: "verified" as const,
            text: "ok",
            structured: { windows: [] },
            images: [],
          })
        : Effect.fail(new ComputerMissionError({ reason: "not this mission's owner" })),
    endMission: (input) => end(input.missionId, input.reason),
    stop: (missionId) =>
      mission === undefined ? Effect.void : end(missionId ?? mission.id, "stopped"),
    events: Stream.fromPubSub(events),
  });
  return { layer, control, current: () => mission };
});

/**
 * Circe's executor. Each run claims its stop registration the way the real
 * one does, then waits on `finish`, and ignores stop requests, so tests can
 * show what happens when it never reports back.
 */
const makeExecutor = Effect.gen(function* () {
  const runs: CirceComputerUseInput[] = [];
  const started = yield* Deferred.make<void>();
  const finish = yield* Deferred.make<CirceComputerUseResult>();
  const layer = Layer.effect(
    CirceComputerUse,
    Effect.gen(function* () {
      const cancellation = yield* CirceMissionCancellation;
      return {
        run: (input: CirceComputerUseInput) => {
          const requestId = input.requestMetadata?.requestId ?? "";
          return cancellation
            .register(requestId)
            .pipe(
              Effect.andThen(Effect.sync(() => runs.push(input))),
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(finish)),
              Effect.ensuring(cancellation.clear(requestId)),
            );
        },
      };
    }),
  );
  return { layer, runs, started, finish };
});

/** The first state that satisfies `accept`; changes emit the current state first, so none is missed. */
const until = (accept: (state: CirceComputerAccessState) => boolean) =>
  Effect.gen(function* () {
    const access = yield* CirceComputerAccess;
    const found = yield* access.changes.pipe(
      Stream.mapEffect(() => access.state),
      Stream.filter(accept),
      Stream.runHead,
    );
    if (found._tag === "None") return yield* Effect.die("computer access stopped changing");
    return found.value;
  });

const threadUi = ThreadId.make("thread-ui");
const runOne = RunId.make("run-1");

/** The node around computer access; `runs` is each thread's running run, as the orchestrator reports it. */
const makeNode = Effect.gen(function* () {
  const computer = yield* makeComputer;
  const executor = yield* makeExecutor;
  // Replayed, so an event published before the service's watcher subscribes still reaches it.
  const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>({ replay: 16 });
  const runs = new Map<string, RunId | null>([[threadUi, runOne]]);
  const layer = CirceComputerAccessLive.pipe(
    Layer.provideMerge(computer.layer),
    Layer.provide(executor.layer),
    Layer.provideMerge(CirceMissionCancellationLive),
    Layer.provideMerge(
      Layer.mock(OrchestratorV2)({
        streamDomainEvents: Stream.fromPubSub(domainEvents),
        getThreadShell: (threadId) =>
          Effect.succeed(
            runs.has(threadId)
              ? ({
                  id: threadId,
                  title: "Fix the settings page",
                  activeRunId: runs.get(threadId) ?? null,
                } as unknown as OrchestrationV2ThreadShell)
              : null,
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("node-1")),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "circe-computer-access-" })),
    Layer.provide(NodeServices.layer),
  );
  const runEnded = (runId: RunId, status = "completed") =>
    PubSub.publish(domainEvents, {
      type: "run.updated",
      payload: { id: runId, threadId: threadUi, status },
    } as unknown as OrchestrationV2DomainEvent);
  return { computer, executor, runs, layer, runEnded };
});

const agent: CirceComputerAgent = {
  kind: "agent",
  threadId: threadUi,
  runId: runOne,
  providerSessionId: "session-ui",
  title: "Fix the settings page",
};

const agentContext = Layer.succeed(McpInvocationContext, {
  environmentId: EnvironmentId.make("node-1"),
  threadId: threadUi,
  providerSessionId: "session-ui",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["computer-use"]) as ReadonlySet<"computer-use">,
  issuedAt: 0,
});

const desk = { kind: "user", origin: "desk" } as const;
const spokenAt = (origin: string) => ({ kind: "spoken", origin }) as const;

describe("CirceComputerAccess", () => {
  it.effect("runs nothing until the user approves, and a correction needs its own approval", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const first = yield* access.request({ goal: "open the browser", requester: desk });
        // "Actually open the settings instead" replaces the goal; it approves nothing.
        const corrected = yield* access.request({
          goal: "open the settings instead",
          requester: desk,
        });
        assert.lengthOf(node.executor.runs, 0);
        const replaced = yield* Effect.flip(access.decide(first.id, "approve", spokenAt("desk")));
        assert.include(replaced.reason, "no longer waiting");
        assert.lengthOf(node.executor.runs, 0);

        yield* access.decide(corrected.id, "approve", spokenAt("desk"));
        yield* Deferred.await(node.executor.started);
        assert.deepStrictEqual(
          node.executor.runs.map((run) => [run.goal, run.confirmed, run.target?.surface]),
          [["open the settings instead", true, "computer"]],
        );
        assert.equal((yield* access.state).active?.id, corrected.id);

        yield* Deferred.succeed(node.executor.finish, {
          status: "done",
          message: "Opened Settings.",
          steps: 2,
        });
        const settled = yield* until((state) => state.active === null);
        assert.include(settled.last, { outcome: "completed", message: "Opened Settings." });
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("takes a spoken yes only from the device that was asked", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const desk = yield* access.request({
          goal: "open the browser",
          requester: { kind: "user", origin: "desk" },
        });
        // The phone cannot swap in its own goal while the desk's waits: a yes
        // meant for one request would otherwise start the other.
        const swapped = yield* Effect.flip(
          access.request({
            goal: "open the calculator",
            requester: { kind: "user", origin: "phone" },
          }),
        );
        assert.include(swapped.reason, "waiting on an answer");
        const refused = yield* Effect.flip(access.decide(desk.id, "approve", spokenAt("phone")));
        assert.include(refused.reason, "another device");
        assert.lengthOf(node.executor.runs, 0);

        // The desk may correct its own request; the card can approve it from anywhere.
        const corrected = yield* access.request({
          goal: "open the browser to the news",
          requester: { kind: "user", origin: "desk" },
        });
        yield* access.decide(corrected.id, "approve", { kind: "explicit" });
        yield* Deferred.await(node.executor.started);
        assert.equal(node.executor.runs[0]?.goal, "open the browser to the news");
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("keeps a grant to the run that was approved, not later runs of the same session", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const request = yield* access.request({ goal: "open the settings", requester: agent });
        // An agent cannot turn a waiting request into another goal.
        const other = yield* Effect.flip(
          access.request({ goal: "open the terminal", requester: agent }),
        );
        assert.include(other.reason, "already asked");
        yield* access.decide(request.id, "approve", { kind: "explicit" });
        yield* until((state) => state.active?.missionId != null);
        assert.isTrue(yield* access.holds({ providerSessionId: "session-ui", runId: runOne }));

        // The run ends without its event reaching the node; the next run in
        // the same session finds no grant, and the stale hold is released.
        const runTwo = RunId.make("run-2");
        node.runs.set(threadUi, runTwo);
        assert.isFalse(yield* access.holds({ providerSessionId: "session-ui", runId: runTwo }));
        const released = yield* until((state) => state.active === null);
        assert.include(released.last, { outcome: "released" });
        assert.isUndefined(node.computer.current());
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("settles a stopped executor even when it never reports back", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const request = yield* access.request({ goal: "open the calculator", requester: desk });
        yield* access.decide(request.id, "approve", spokenAt("desk"));
        yield* Deferred.await(node.executor.started);
        const stopping = yield* access.stop(request.id).pipe(Effect.forkChild);
        // The executor ignores the stop, so the bounded wait runs out and the
        // run is interrupted; it still settles, as uncertain, not as done.
        yield* TestClock.adjust("15 seconds");
        assert.isTrue(yield* Fiber.join(stopping));
        const state = yield* until((current) => current.active === null);
        assert.include(state.last, { outcome: "uncertain" });
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("runs a start the panel approved through the same owner, and stops it by its id", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const running = yield* access
          .run({ goal: "open the calculator", cancelId: "panel-1" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(node.executor.started);
        assert.equal(node.executor.runs[0]?.requestMetadata?.requestId, "panel-1");
        // One owner: a second route sees the computer as busy.
        const busy = yield* access.run({ goal: "open the browser" });
        assert.include(busy, { status: "refused" });
        assert.isFalse(yield* access.stop("someone-else"));

        yield* Deferred.succeed(node.executor.finish, {
          status: "cancelled",
          message: "Stopped after 1 step.",
          steps: 1,
        });
        assert.include(yield* Fiber.join(running), { status: "cancelled" });
        assert.include((yield* access.state).last, { outcome: "stopped" });
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("hands an approved agent a mission owned by its own session, until its run ends", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const tools = yield* makeComputerTools;

        // Before asking, the agent's action tools refuse and point at computer_begin.
        const refused = yield* Effect.flip(tools.computer_list_windows({}));
        assert.include(refused, { code: "mission-required" });
        assert.include(refused.message, "computer_begin");

        const asking = yield* tools
          .computer_begin({ goal: "check the settings page renders" })
          .pipe(Effect.forkChild);
        const pending = (yield* until((state) => state.pending !== null)).pending!;
        assert.deepStrictEqual(pending.requester, agent);
        yield* access.decide(pending.id, "approve", { kind: "explicit" });
        const granted = yield* Fiber.join(asking);
        assert.equal(granted.status, "granted");
        assert.deepStrictEqual(node.computer.current()?.owner, {
          kind: "provider",
          threadId: "thread-ui",
          providerSessionId: "session-ui",
        });
        assert.lengthOf(node.executor.runs, 0);

        const windows = yield* tools.computer_list_windows({});
        assert.deepStrictEqual(windows.windows, []);

        // A queued run in the same thread ending is not this run ending.
        yield* node.runEnded(RunId.make("run-queued"), "cancelled");
        assert.isDefined(node.computer.current());

        yield* node.runEnded(runOne);
        const released = yield* until((state) => state.active === null);
        assert.include(released.last, { outcome: "released" });
        assert.isUndefined(node.computer.current());
      }).pipe(Effect.provide(node.layer), Effect.provide(agentContext));
    }),
  );

  it.effect("withdraws an agent's request when its run ends before the user answers", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const request = yield* access.request({ goal: "open the settings", requester: agent });
        yield* node.runEnded(runOne, "interrupted");
        const withdrawn = yield* until((state) => state.pending === null);
        assert.include(withdrawn.last, { outcome: "declined" });

        // A run that ended without its event reaching us is caught at approval.
        const again = yield* access.request({ goal: "open the settings", requester: agent });
        node.runs.set(threadUi, null);
        const late = yield* Effect.flip(access.decide(again.id, "approve", { kind: "explicit" }));
        assert.include(late.reason, "run ended");
        assert.isUndefined(node.computer.current());
        assert.notEqual(request.id, again.id);
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("ends a mission that was admitted after its request was stopped", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      const admission = yield* Deferred.make<void>();
      node.computer.control.admission = admission;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const request = yield* access.request({ goal: "open the settings", requester: agent });
        const approving = yield* access
          .decide(request.id, "approve", { kind: "explicit" })
          .pipe(Effect.flip, Effect.forkChild);
        yield* until((state) => state.active !== null);
        assert.isTrue(yield* access.stop());
        yield* Deferred.succeed(admission, undefined);
        const failure = yield* Fiber.join(approving);
        assert.include(failure.reason, "withdrawn");
        assert.isUndefined(node.computer.current());
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("finishes admitting an agent's mission when the approving client goes away", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      const admission = yield* Deferred.make<void>();
      node.computer.control.admission = admission;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const view = yield* access.view.pipe(Stream.runHead);
        assert.include(view._tag === "Some" ? view.value : {}, {
          controllable: true,
          available: true,
        });

        const request = yield* access.request({ goal: "open the settings", requester: agent });
        const approving = yield* access
          .decide(request.id, "approve", { kind: "explicit" })
          .pipe(Effect.forkChild);
        yield* until((state) => state.active !== null);
        yield* Fiber.interrupt(approving);
        yield* Deferred.succeed(admission, undefined);
        const held = yield* until((state) => state.active?.missionId != null);
        assert.equal(held.active?.id, request.id);
        assert.deepStrictEqual(node.computer.current()?.owner, {
          kind: "provider",
          threadId: "thread-ui",
          providerSessionId: "session-ui",
        });
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("admits exactly one of two requests racing for an empty computer", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const [first, second] = yield* Effect.all(
          [
            access.request({ goal: "open the settings", requester: agent }).pipe(Effect.result),
            access.request({ goal: "open the terminal", requester: agent }).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        const admitted = [first, second].filter((result) => result._tag === "Success");
        assert.lengthOf(admitted, 1);
        const waiting = (yield* access.state).pending;
        assert.equal(
          waiting?.id,
          admitted[0]?._tag === "Success" ? admitted[0].success.id : undefined,
        );
      }).pipe(Effect.provide(node.layer));
    }),
  );

  it.effect("takes a spoken yes to an agent only for the request the speaker was shown", () =>
    Effect.gen(function* () {
      const node = yield* makeNode;
      yield* Effect.gen(function* () {
        const access = yield* CirceComputerAccess;
        const request = yield* access.request({ goal: "open the settings", requester: agent });
        // The device was showing an earlier request, or none at all.
        const stale = yield* Effect.flip(
          access.decide(request.id, "approve", {
            kind: "spoken",
            origin: "desk",
            presented: "an-earlier-request",
          }),
        );
        assert.include(stale.reason, "Computer card");
        const unseen = yield* Effect.flip(access.decide(request.id, "approve", spokenAt("desk")));
        assert.include(unseen.reason, "Computer card");
        assert.isNull((yield* access.state).active);

        yield* access.decide(request.id, "approve", {
          kind: "spoken",
          origin: "desk",
          presented: request.id,
        });
        yield* until((state) => state.active?.missionId != null);
      }).pipe(Effect.provide(node.layer));
    }),
  );
});
