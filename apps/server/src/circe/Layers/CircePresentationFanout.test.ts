import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@circe/contracts";
import { describe, expect, it } from "vite-plus/test";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { it as itEffect } from "@effect/vitest";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { buildV2TurnPresentation } from "../presentation.ts";
import { CircePresentationFanout } from "../Services/CircePresentationFanout.ts";
import {
  CircePresentationFanoutLive,
  withPresentationResubscribe,
} from "./CircePresentationFanout.ts";

const NODE_ID = EnvironmentId.make("node-fanout");

/**
 * Focused V2 projection fixture. Only the fields the fanout reads are real;
 * the rest is an empty shape.
 */
const projectionFor = (
  threadId: string,
  originInteractionId: string,
): OrchestrationV2ThreadProjection => {
  const id = ThreadId.make(threadId);
  const runId = RunId.make(`run-${threadId}`);
  const attemptId = RunAttemptId.make(`attempt-${threadId}`);
  const providerTurnId = ProviderTurnId.make(`turn-${threadId}`);
  return {
    thread: {
      createdBy: "user",
      creationSource: "server",
      id,
      projectId: ProjectId.make("project-fanout"),
      title: "Fanout task",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      activeProviderThreadId: null,
      clientRouting: { originInteractionId },
    },
    runs: [],
    attempts: [{ id: attemptId, runId, providerTurnId }],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [
      {
        id: providerTurnId,
        runAttemptId: attemptId,
        status: "completed",
      },
    ],
    runtimeRequests: [],
    messages: [
      {
        id: MessageId.make(`message-final-${threadId}`),
        threadId: id,
        runId,
        role: "assistant",
        text: `Done for ${originInteractionId}.`,
        attachments: [],
        streaming: false,
      },
    ],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: DateTime.makeUnsafe("2026-08-30T00:01:00.000Z"),
  } as unknown as OrchestrationV2ThreadProjection;
};

const completionEvent = (
  threadId: string,
): Extract<OrchestrationV2DomainEvent, { readonly type: "provider-turn.updated" }> =>
  ({
    id: EventId.make(`event-completed-${threadId}`),
    threadId: ThreadId.make(threadId),
    occurredAt: DateTime.makeUnsafe("2026-08-30T00:02:00.000Z"),
    type: "provider-turn.updated",
    payload: {
      id: ProviderTurnId.make(`turn-${threadId}`),
      providerThreadId: ProviderThreadId.make(`provider-thread-${threadId}`),
      nodeId: `node-${threadId}`,
      runAttemptId: RunAttemptId.make(`attempt-${threadId}`),
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: DateTime.makeUnsafe("2026-08-30T00:00:00.000Z"),
      completedAt: DateTime.makeUnsafe("2026-08-30T00:02:00.000Z"),
    },
  }) as unknown as Extract<OrchestrationV2DomainEvent, { readonly type: "provider-turn.updated" }>;

const harness = (threads: ReadonlyArray<OrchestrationV2ThreadProjection>) =>
  Effect.gen(function* () {
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
    const detailReads = yield* Ref.make(0);
    const orchestratorLayer = Layer.mock(OrchestratorV2)({
      streamDomainEvents: Stream.fromPubSub(liveEvents),
      getThreadProjection: (threadId: ThreadId) =>
        Effect.gen(function* () {
          yield* Ref.update(detailReads, (count) => count + 1);
          const projection = threads.find((candidate) => candidate.thread.id === threadId);
          return (
            projection ?? (yield* Effect.die(new Error(`No projection fixture for ${threadId}`)))
          );
        }),
    });
    const environmentLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(NODE_ID),
    });
    const layer = CircePresentationFanoutLive.pipe(
      Layer.provideMerge(orchestratorLayer),
      Layer.provideMerge(environmentLayer),
    );
    return { liveEvents, detailReads, layer };
  });

describe("Circe presentation fanout", () => {
  it("builds a completion presentation from the fixture", () => {
    const presentation = buildV2TurnPresentation({
      projection: projectionFor("thread-one", "interaction-one"),
      providerTurnId: ProviderTurnId.make("turn-thread-one"),
      presentationId: "event-completed-thread-one",
      executionNodeId: NODE_ID,
      occurredAt: "2026-08-30T00:02:00.000Z",
    });
    expect(presentation).not.toBeNull();
    expect(presentation?.text).toBe("Done for interaction-one.");
  });

  itEffect.live("projects each event once and routes it to the matching origin only", () =>
    Effect.gen(function* () {
      const setup = yield* harness([
        projectionFor("thread-one", "interaction-one"),
        projectionFor("thread-two", "interaction-two"),
      ]);
      const { liveEvents, detailReads, layer } = setup;
      yield* Effect.gen(function* () {
        const fanout = yield* CircePresentationFanout;
        const firstFiber = yield* Effect.forkChild(
          Stream.runCollect(
            fanout.subscribe({ originInteractionId: "interaction-one" }).pipe(Stream.take(1)),
          ),
        );
        const secondFiber = yield* Effect.forkChild(
          Stream.runCollect(
            fanout.subscribe({ originInteractionId: "interaction-two" }).pipe(Stream.take(1)),
          ),
        );
        // Let both subscriptions register: PubSub drops messages published
        // before a subscriber exists, and the pump owns the only durable
        // read. Fiber scheduling is sub-millisecond; this margin only
        // covers test scheduling, never product timing.
        yield* Effect.sleep("100 millis");

        yield* PubSub.publish(liveEvents, completionEvent("thread-one"));
        yield* PubSub.publish(liveEvents, completionEvent("thread-two"));

        const firstItems = yield* Fiber.join(firstFiber);
        const secondItems = yield* Fiber.join(secondFiber);

        expect(firstItems.length).toBe(1);
        expect(firstItems[0]?.text).toBe("Done for interaction-one.");
        expect(secondItems.length).toBe(1);
        expect(secondItems[0]?.text).toBe("Done for interaction-two.");
        // One projection read per event, not per subscriber: two events, two reads.
        expect(yield* Ref.get(detailReads)).toBe(2);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  itEffect.live("gives late subscribers future events without replaying past speech", () =>
    Effect.gen(function* () {
      const setup = yield* harness([projectionFor("thread-one", "interaction-one")]);
      const { liveEvents, layer } = setup;
      yield* Effect.gen(function* () {
        const fanout = yield* CircePresentationFanout;
        const earlyFiber = yield* Effect.forkChild(
          Stream.runCollect(
            fanout.subscribe({ originInteractionId: "interaction-one" }).pipe(Stream.take(1)),
          ),
        );
        yield* Effect.sleep("100 millis");

        yield* PubSub.publish(liveEvents, completionEvent("thread-one"));
        const earlyItems = yield* Fiber.join(earlyFiber);
        expect(earlyItems.length).toBe(1);

        // Subscribed after the first completion: the past presentation must
        // not replay. A short live-clock window is enough for anything
        // deliverable to arrive.
        const lateItems = yield* Stream.runCollect(
          fanout.subscribe({ originInteractionId: "interaction-one" }).pipe(Stream.take(1)),
        ).pipe(Effect.timeoutOption("200 millis"));
        expect(lateItems._tag).toBe("None");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  itEffect.effect("resubscribes a dying source stream instead of silencing every subscriber", () =>
    Effect.gen(function* () {
      let subscriptions = 0;
      const processed: Array<string> = [];
      // Production failure mode: the pump is Stream.runForEach over
      // Stream<OrchestrationEvent, never>, so death arrives as a defect with
      // no typed failure channel — never as Effect.fail.
      const failure = yield* withPresentationResubscribe<void, never, never>(
        Effect.gen(function* () {
          subscriptions += 1;
          if (subscriptions < 3) {
            yield* Stream.runForEach(Stream.die(new Error("event bus died")), () => Effect.void);
          } else {
            yield* Stream.runForEach(Stream.make("live-event"), (event) =>
              Effect.sync(() => {
                processed.push(event);
              }),
            );
          }
        }),
        Schedule.recurs(2),
      ).pipe(Effect.flip);
      // Attempts 1-2 die and resubscribe; attempt 3 processes its event, then
      // its normal completion also resubscribes until the schedule exhausts.
      expect(subscriptions).toBe(3);
      expect(processed).toEqual(["live-event"]);
      expect(failure._tag).toBe("PresentationSubscriptionStopped");
    }),
  );

  itEffect.effect("resubscribes a normally completed source stream instead of going silent", () =>
    Effect.gen(function* () {
      let subscriptions = 0;
      const failure = yield* withPresentationResubscribe<void, never, never>(
        Effect.gen(function* () {
          subscriptions += 1;
          yield* Stream.runForEach(Stream.empty, () => Effect.void);
        }),
        Schedule.recurs(1),
      ).pipe(Effect.flip);
      // Both attempts complete normally and each completion resubscribes
      // until the schedule exhausts.
      expect(subscriptions).toBe(2);
      expect(failure._tag).toBe("PresentationSubscriptionStopped");
    }),
  );

  itEffect.effect("lets shutdown interruption exit instead of resubscribing", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        withPresentationResubscribe<never, never, never>(Effect.interrupt, Schedule.recurs(5)),
      );
      expect(Exit.hasInterrupts(exit)).toBe(true);
    }),
  );
});
