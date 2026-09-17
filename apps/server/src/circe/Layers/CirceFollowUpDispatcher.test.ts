import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@circe/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  OrchestratorDispatchError,
  OrchestratorV2,
} from "../../orchestration-v2/Orchestrator.ts";
import { emptyProjection } from "../../orchestration-v2/ProjectionStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { CirceFollowUpQueue } from "../Services/CirceFollowUpQueue.ts";
import { makeCirceFollowUpDispatcher } from "./CirceFollowUpDispatcher.ts";
import { CirceFollowUpQueueLive } from "./CirceFollowUpQueue.ts";

const threadId = ThreadId.make("thread-race");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const createdAt = "2026-08-30T00:00:00.000Z";
const createdAtDate = DateTime.makeUnsafe(createdAt);

const readyThread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-race"),
  title: "Race task",
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt,
  updatedAt: "2026-08-30T00:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId,
    status: "ready",
    providerName: "codex",
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-08-30T00:01:00.000Z",
  },
};

const runningThread: OrchestrationThread = {
  ...readyThread,
  session: { ...readyThread.session!, status: "running" },
};

function projectionWithRun(status: OrchestrationV2Run["status"]): OrchestrationV2ThreadProjection {
  const base = emptyProjection({
    id: EventId.make("event:race-created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAtDate,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: readyThread.projectId,
      title: readyThread.title,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: createdAtDate,
      updatedAt: createdAtDate,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const run: OrchestrationV2Run = {
    id: RunId.make("run:race"),
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
    providerThreadId: ProviderThreadId.make("provider-thread:race"),
    userMessageId: MessageId.make("message:race"),
    rootNodeId: NodeId.make("node:race"),
    activeAttemptId: RunAttemptId.make("attempt:race"),
    status,
    queuePosition: null,
    requestedAt: createdAtDate,
    startedAt: createdAtDate,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  return { ...base, runs: [run] };
}

function harness(
  cancelOnClaim: boolean,
  hooks?: {
    readonly onDetail?: () => void;
    readonly projection?: () => OrchestrationV2ThreadProjection;
  },
) {
  const commands: Array<OrchestrationV2Command> = [];
  const baseQueue = CirceFollowUpQueueLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
  const queueLayer =
    cancelOnClaim === false
      ? baseQueue
      : Layer.unwrap(
          Effect.map(Layer.build(baseQueue), (context) => {
            const queue = Context.get(context, CirceFollowUpQueue);
            return Layer.succeed(CirceFollowUpQueue, {
              ...queue,
              claimNext: (claimedThreadId: ThreadId) =>
                queue
                  .claimNext(claimedThreadId)
                  .pipe(
                    Effect.tap((claimed) =>
                      Option.isSome(claimed)
                        ? queue.cancelPending(claimedThreadId, "2026-08-30T00:01:00.000Z")
                        : Effect.void,
                    ),
                  ),
            });
          }),
        );
  const orchestratorLayer = Layer.mock(OrchestratorV2)({
    dispatch: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length, storedEvents: [] };
      }),
    getThreadProjection: () =>
      Effect.succeed(
        hooks?.projection?.() ??
          projectionWithRun("running"),
      ),
    streamDomainEvents: Stream.empty,
  });
  const projectionsLayer = Layer.mock(ProjectionSnapshotQuery)({
    getThreadDetailById: (id: ThreadId) =>
      Effect.sync(() => {
        hooks?.onDetail?.();
        return id === threadId ? Option.some(readyThread) : Option.none();
      }),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getShellSnapshot: () =>
      Effect.succeed({ snapshotSequence: 1, projects: [], threads: [], updatedAt: "" }),
  });
  return {
    commands,
    layer: Layer.mergeAll(
      queueLayer,
      orchestratorLayer,
      projectionsLayer,
      Layer.mock(ProjectionTurnRepository)({
        getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
      }),
    ),
  };
}

function runOnce(layer: ReturnType<typeof harness>["layer"]) {
  return Effect.scoped(
    Effect.gen(function* () {
      const queue = yield* CirceFollowUpQueue;
      yield* queue.enqueue({
        queueId: "race-1",
        threadId,
        instruction: "Continue after the stop.",
        enqueuedAt: createdAt,
      });
      const dispatcher = yield* makeCirceFollowUpDispatcher;
      yield* dispatcher.reconcileThread(threadId);
      yield* dispatcher.drain;
    }).pipe(Effect.provide(layer)),
  );
}

describe("Circe follow-up dispatcher", () => {
  effectIt.effect("dispatches a queued turn as a queue_after_active message", () => {
    const layers = harness(false);
    return runOnce(layers.layer).pipe(
      Effect.map(() => {
        expect(layers.commands.map((command) => command.type)).toEqual(["message.dispatch"]);
        expect(layers.commands[0]).toMatchObject({
          type: "message.dispatch",
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        });
      }),
    );
  });

  effectIt.effect("dispatches nothing when a stop cancels the claim mid-flight", () => {
    const layers = harness(true);
    return runOnce(layers.layer).pipe(
      Effect.map(() => {
        expect(layers.commands).toEqual([]);
      }),
    );
  });

  effectIt.effect("skips the thread hydrate when no follow-up is queued", () => {
    let detailCalls = 0;
    const layers = harness(false, {
      onDetail: () => {
        detailCalls += 1;
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const dispatcher = yield* makeCirceFollowUpDispatcher;
        yield* dispatcher.reconcileThread(threadId);
        yield* dispatcher.drain;
        expect(detailCalls).toBe(0);
        expect(layers.commands).toEqual([]);
      }).pipe(Effect.provide(layers.layer)),
    );
  });
});

const makeRaceHarness = Effect.gen(function* () {
  const queue = yield* CirceFollowUpQueue;
  const commands: Array<OrchestrationV2Command> = [];
  let current = readyThread;
  let projection = projectionWithRun("running");
  let beforeStatusReturn: Effect.Effect<void> = Effect.void;
  let beforeDispatch: (
    command: OrchestrationV2Command,
  ) => Effect.Effect<void, OrchestratorDispatchError> = () => Effect.void;
  const dispatcher = yield* makeCirceFollowUpDispatcher.pipe(
    Effect.provideService(CirceFollowUpQueue, {
      ...queue,
      statusOf: (queueId) => queue.statusOf(queueId).pipe(Effect.tap(() => beforeStatusReturn)),
    }),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadDetailById: () => Effect.sync(() => Option.some(current)),
        }),
        Layer.mock(OrchestratorV2)({
          dispatch: (command) =>
            Effect.gen(function* () {
              yield* beforeDispatch(command);
              commands.push(command);
              // An accepted dispatch makes the thread active, exactly as the
              // real V2 projection would. A stop that lands after acceptance
              // therefore sees live work and interrupts it.
              if (command.type === "message.dispatch") {
                current = runningThread;
                projection = projectionWithRun("running");
              }
              return { sequence: commands.length, storedEvents: [] };
            }),
          getThreadProjection: () => Effect.succeed(projection),
          streamDomainEvents: Stream.empty,
        }),
      ),
    ),
  );
  return {
    queue,
    dispatcher,
    commands,
    setCurrent: (thread: OrchestrationThread) => {
      current = thread;
    },
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    setStatusHook: (effect: Effect.Effect<void>) => {
      beforeStatusReturn = effect;
    },
    setDispatchHook: (hook: typeof beforeDispatch) => {
      beforeDispatch = hook;
    },
    enqueue: (queueId: string, origin = false) =>
      queue.enqueue({
        queueId,
        threadId,
        instruction: queueId,
        ...(origin
          ? { requestMetadata: { requestId: queueId, origin: { originInteractionId: queueId } } }
          : {}),
        enqueuedAt: createdAt,
      }),
  };
});

const stopInput = {
  threadId,
  commandId: CommandId.make("stop-race"),
  createdAt: "2026-08-30T00:01:00.000Z",
};
const raceLayer = Layer.mergeAll(CirceFollowUpQueueLive, ProjectionTurnRepositoryLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

effectIt.effect("a stop after the status read wins before turn acceptance", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRaceHarness;
      const statusRead = yield* Deferred.make<void>();
      const continueStatus = yield* Deferred.make<void>();
      harness.setStatusHook(
        Deferred.succeed(statusRead, undefined).pipe(Effect.andThen(Deferred.await(continueStatus))),
      );
      yield* harness.enqueue("stop-after-status");
      yield* harness.dispatcher.reconcileThread(threadId);
      yield* Deferred.await(statusRead);
      const stopping = yield* harness.dispatcher
        .stop(stopInput)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(continueStatus, undefined);
      expect(yield* Fiber.join(stopping)).toEqual({ interrupted: false, cancelledFollowUps: 1 });
      yield* harness.dispatcher.drain;
      expect(harness.commands).toEqual([]);
      expect(yield* harness.queue.statusOf("stop-after-status")).toEqual(Option.some("cancelled"));
    }).pipe(Effect.provide(raceLayer)),
  ),
);

effectIt.effect("a stop waiting for an accepted start interrupts that turn using fresh state", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRaceHarness;
      const startEntered = yield* Deferred.make<void>();
      const acceptStart = yield* Deferred.make<void>();
      harness.setDispatchHook((command) =>
        command.type === "message.dispatch"
          ? Deferred.succeed(startEntered, undefined).pipe(Effect.andThen(Deferred.await(acceptStart)))
          : Effect.void,
      );
      yield* harness.enqueue("accepted-before-stop");
      yield* harness.enqueue("cancel-after-start");
      yield* harness.dispatcher.reconcileThread(threadId);
      yield* Deferred.await(startEntered);
      const stopping = yield* harness.dispatcher
        .stop(stopInput)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(acceptStart, undefined);
      expect(yield* Fiber.join(stopping)).toEqual({ interrupted: true, cancelledFollowUps: 1 });
      yield* harness.dispatcher.drain;
      expect(harness.commands.map((command) => command.type)).toEqual([
        "message.dispatch",
        "run.interrupt",
      ]);
      expect(yield* harness.queue.statusOf("accepted-before-stop")).toEqual(
        Option.some("dispatched"),
      );
      expect(yield* harness.queue.statusOf("cancel-after-start")).toEqual(Option.some("cancelled"));
    }).pipe(Effect.provide(raceLayer)),
  ),
);

effectIt.effect(
  "retries transient dispatch failures without another readiness event and preserves FIFO",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeRaceHarness;
        const failed = yield* Deferred.make<void>();
        let attempts = 0;
        harness.setDispatchHook((command) =>
          Effect.gen(function* () {
            if (command.type !== "message.dispatch") return;
            attempts += 1;
            if (attempts === 1) {
              yield* Deferred.succeed(failed, undefined);
              return yield* new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
              });
            }
          }),
        );
        yield* harness.enqueue("retry-first", true);
        yield* harness.enqueue("retry-second");
        yield* harness.dispatcher.reconcileThread(threadId);
        yield* Deferred.await(failed);
        yield* TestClock.adjust("1 second");
        yield* harness.dispatcher.drain;
        expect(attempts).toBe(2);
        expect(harness.commands.filter((command) => command.type === "message.dispatch")).toHaveLength(
          1,
        );
        const dispatched = harness.commands.find((command) => command.type === "message.dispatch");
        expect(dispatched).toMatchObject({ text: "retry-first" });
        expect(yield* harness.queue.statusOf("retry-first")).toEqual(Option.some("dispatched"));
        expect(yield* harness.queue.statusOf("retry-second")).toEqual(Option.some("pending"));
      }).pipe(Effect.provide(raceLayer)),
    ),
);

effectIt.effect("coalesces simultaneous wakeups without starting the next queued row", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRaceHarness;
      const startEntered = yield* Deferred.make<void>();
      const acceptStart = yield* Deferred.make<void>();
      harness.setDispatchHook((command) =>
        command.type === "message.dispatch"
          ? Deferred.succeed(startEntered, undefined).pipe(Effect.andThen(Deferred.await(acceptStart)))
          : Effect.void,
      );
      yield* harness.enqueue("simultaneous-first");
      yield* harness.enqueue("simultaneous-second");
      yield* harness.dispatcher.reconcileThread(threadId);
      yield* Deferred.await(startEntered);
      yield* Effect.forEach(
        Array.from({ length: 20 }),
        () => harness.dispatcher.reconcileThread(threadId),
        { concurrency: "unbounded" },
      );
      yield* Deferred.succeed(acceptStart, undefined);
      yield* harness.dispatcher.drain;
      expect(harness.commands).toHaveLength(1);
      expect(yield* harness.queue.statusOf("simultaneous-second")).toEqual(Option.some("pending"));
    }).pipe(Effect.provide(raceLayer)),
  ),
);
