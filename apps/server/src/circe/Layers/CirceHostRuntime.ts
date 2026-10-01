import {
  ProjectId,
  ThreadId,
  type CirceHostFocus,
  type CirceHostListenInput,
  type CirceHostListenResult,
  type CirceHostNotice,
  type CirceHostSayInput,
  type CirceHostSayResult,
  type CirceHostTranscribeInput,
  type CirceHostTranscribeResult,
  type OrchestrationV2DomainEvent,
} from "@circe/contracts";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { loadCirceCore, type Focus } from "../host/core.ts";
import { makeJevRoute } from "../host/jevRoute.ts";
import { approvalQuestion, isComputerPlace } from "../host/computerPlace.ts";
import { makeNodeHost } from "../host/nodeHost.ts";
import { makeNodeVoice } from "../host/nodeVoice.ts";
import { CirceBots } from "../Services/CirceBots.ts";
import { CirceComputerAccess } from "../Services/CirceComputerAccess.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceHostRuntime } from "../Services/CirceHostRuntime.ts";
import { withPresentationResubscribe } from "./CircePresentationFanout.ts";

const NOTICE_CAPACITY = 64;

/** Domain events that can change what Circe would say about a thread; streaming text is not one. */
const STATE_EVENTS: ReadonlySet<OrchestrationV2DomainEvent["type"]> = new Set([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "run.created",
  "run.updated",
  "runtime-request.updated",
]);

const unavailable: CirceHostSayResult = {
  status: "unavailable",
  said: "The Circe host layer is off on this node.",
  started: [],
};

export const CirceHostRuntimeLive = Layer.effect(
  CirceHostRuntime,
  Effect.gen(function* () {
    const enabled = yield* Config.boolean("CIRCE_HOST_ENABLED").pipe(
      Config.withDefault(true),
      Effect.catch((error) =>
        Effect.logWarning("CIRCE_HOST_ENABLED is not a boolean; the Circe host layer stays on", {
          error,
        }).pipe(Effect.as(true)),
      ),
    );
    // circe-core is private: a checkout without it runs with the layer off.
    const core = enabled ? yield* Effect.promise(loadCirceCore) : undefined;
    if (enabled && core === undefined) {
      yield* Effect.logInfo("circe-core is not installed; the Circe host layer is off");
    }
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const orchestrator = yield* OrchestratorV2;
    const bots = yield* CirceBots;
    const computer = yield* CirceComputerAccess;
    // circe-core handles one turn at a time; the node host reads the turn's
    // device session from here while carrying that turn out.
    let turnOrigin: string | null = null;
    const turnLock = yield* Semaphore.make(1);
    const heldThisTurn = new Set<string>();
    let turnPhase: "turn" | "own" | "open" = "open";
    let turnNumber = 0;
    let turnPresentedComputerRequest: string | null = null;
    const host = yield* makeNodeHost({
      turnOrigin: () => turnOrigin,
      turnPresentedComputerRequest: () => turnPresentedComputerRequest,
      heldThisTurn,
      turnPhase: () => ({ phase: turnPhase, turn: turnNumber }),
    });
    const voice = yield* makeNodeVoice;
    const context = yield* Effect.context<never>();
    const run = <A>(effect: Effect.Effect<A>) => Effect.runPromiseWith(context)(effect);

    const routedJev = yield* makeJevRoute(yield* CirceDecision);

    const directory = path.join(config.stateDir, "circe-host");
    const circe =
      core === undefined
        ? undefined
        : core.createCirce({
            host,
            jev: routedJev(core),
            memoryFile: path.join(directory, "memory.json"),
            logFile: path.join(directory, "decisions.jsonl"),
          });

    const hub = yield* PubSub.sliding<CirceHostNotice>(NOTICE_CAPACITY);
    // Notices raised while a turn catches up on its own work are about that
    // turn, so they go to its device only; every other notice is for all.
    let noticeAudience: string | null = null;
    circe?.onNotice((text) => {
      const origin = noticeAudience;
      void run(
        crypto.randomUUIDv4.pipe(
          Effect.orDie,
          Effect.flatMap((id) =>
            PubSub.publish(hub, { id, text, ...(origin === null ? {} : { origin }) }),
          ),
        ),
      );
    });

    // Owned like the presentation pump: the fiber dies with this layer.
    const pumpScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    if (circe !== undefined) {
      yield* Effect.promise(() => circe.refresh().catch(() => []));
      // Grok Bot messages and replies change the world too, so a bot's
      // answer reaches circe-core the same way an agent finishing does, and
      // so does an agent asking to use this computer.
      const pump = orchestrator.streamDomainEvents.pipe(
        Stream.filter((event) => STATE_EVENTS.has(event.type)),
        Stream.map((): void => undefined),
        Stream.merge(bots.changes),
        Stream.merge(computer.changes),
        Stream.debounce(Duration.millis(300)),
        // Refreshes take the turn lock too, so a notice is never raised
        // while a turn's own catch-up is tagging notices with its device.
        Stream.runForEach(() =>
          turnLock
            .withPermits(1)(Effect.promise(() => circe.refresh()))
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Circe host refresh failed", { cause }),
              ),
            ),
        ),
      );
      yield* withPresentationResubscribe(pump).pipe(Effect.forkIn(pumpScope));
    }

    /**
     * Where the client should go. The coding UI has no page for a project on
     * its own, so opening a project shows its most recent thread. The
     * computer has no page: its state is what Circe says.
     */
    const screenFor = (focus: Focus | undefined) =>
      Effect.promise(async (): Promise<CirceHostFocus | undefined> => {
        if (focus === undefined) return undefined;
        if (isComputerPlace(focus.threadId) || isComputerPlace(focus.projectId)) return undefined;
        if (focus.threadId !== undefined) {
          return {
            threadId: ThreadId.make(focus.threadId),
            ...(focus.projectId === undefined
              ? {}
              : { projectId: ProjectId.make(focus.projectId) }),
          };
        }
        if (focus.projectId === undefined) return undefined;
        const latest = (await host.state()).threads.find(
          (thread) => thread.projectId === focus.projectId && thread.archived !== true,
        );
        return {
          projectId: ProjectId.make(focus.projectId),
          ...(latest === undefined ? {} : { threadId: ThreadId.make(latest.id) }),
        };
      });

    /**
     * A turn that asked to use the computer is a question to the user, not
     * work that started: circe-core reports it as started, and the approval
     * it now waits on is what the user has to hear.
     */
    const askedToUseComputer = (pendingBefore: string | null, reply: CirceHostSayResult) =>
      Effect.gen(function* () {
        if (reply.status !== "acted" || !computer.controllable) return reply;
        const pending = (yield* computer.state).pending;
        if (pending === null || pending.id === pendingBefore || pending.requester.kind !== "user") {
          return reply;
        }
        return {
          status: "asked",
          said: approvalQuestion(pending),
          options: ["Yes", "No"],
          started: reply.started.filter((threadId) => !isComputerPlace(threadId)),
        } satisfies CirceHostSayResult;
      });

    const say = (input: CirceHostSayInput): Effect.Effect<CirceHostSayResult> =>
      circe !== undefined
        ? // circe-core cannot abandon a turn it started, so neither can this:
          // an interrupted caller waits for the turn instead of releasing the
          // lock and its origin while circe-core still carries it out.
          Effect.uninterruptible(
            turnLock.withPermits(1)(
              Effect.gen(function* () {
                const pendingBefore = computer.controllable
                  ? ((yield* computer.state).pending?.id ?? null)
                  : null;
                turnOrigin = input.origin ?? null;
                turnPresentedComputerRequest = input.presentedComputerRequest ?? null;
                turnNumber += 1;
                turnPhase = "turn";
                const reply = yield* sayToCirce(input).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      turnOrigin = null;
                      turnPresentedComputerRequest = null;
                    }),
                  ),
                );
                const asked = yield* askedToUseComputer(pendingBefore, reply);
                // The world the turn froze opens in two steps. First the turn's
                // own work, whose news belongs to the asking device; then the
                // rest, including an agent's request that arrived meanwhile,
                // which is news for everyone.
                turnPhase = "own";
                noticeAudience = input.origin ?? null;
                yield* Effect.promise(() => circe.refresh().catch(() => []));
                heldThisTurn.clear();
                turnPhase = "open";
                noticeAudience = null;
                yield* Effect.promise(() => circe.refresh().catch(() => []));
                return asked;
              }),
            ),
          )
        : Effect.succeed(unavailable);

    const sayToCirce = (input: CirceHostSayInput): Effect.Effect<CirceHostSayResult> =>
      circe !== undefined
        ? Effect.tryPromise(() =>
            circe.say(
              input.utterance,
              input.focus === undefined
                ? {}
                : {
                    focus: {
                      ...(input.focus.threadId === undefined
                        ? {}
                        : { threadId: input.focus.threadId }),
                      ...(input.focus.projectId === undefined
                        ? {}
                        : { projectId: input.focus.projectId }),
                    },
                  },
            ),
          ).pipe(
            Effect.flatMap((reply) =>
              screenFor(reply.navigate).pipe(
                Effect.map((navigate): CirceHostSayResult => ({
                  status: reply.status,
                  said: reply.said,
                  ...(reply.options === undefined ? {} : { options: reply.options }),
                  ...(navigate === undefined ? {} : { navigate }),
                  started: reply.started
                    .filter((threadId) => !isComputerPlace(threadId))
                    .map((threadId) => ThreadId.make(threadId)),
                })),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Circe host turn failed", { cause }).pipe(
                Effect.as<CirceHostSayResult>({
                  status: "failed",
                  said: "Something went wrong on my side. Try that again.",
                  started: [],
                }),
              ),
            ),
          )
        : Effect.succeed(unavailable);

    /** Names the user is likely to say, so the transcript spells them the way Circe knows them. */
    const vocabulary = Effect.promise(async () => {
      const state = await host.state();
      const names = [
        ...state.projects.map((project) => project.name),
        ...state.threads
          .filter((thread) => thread.archived !== true)
          .slice(0, 24)
          .map((thread) => thread.title),
      ];
      return [...new Set(names)].join(", ").slice(0, 1_800);
    });

    const listen = (input: CirceHostListenInput): Effect.Effect<CirceHostListenResult> =>
      Effect.gen(function* () {
        // Without circe-core the words still come back, so the client can
        // carry them out through its own path instead of dropping them.
        const heard = yield* voice
          .transcribe({
            audio: input.audio,
            mimeType: input.mimeType,
            vocabulary: yield* vocabulary,
          })
          .pipe(Effect.result);
        if (heard._tag === "Failure") {
          return { status: "failed" as const, said: heard.failure.reason, started: [], heard: "" };
        }
        if (heard.success.length === 0) {
          return {
            status: "failed" as const,
            said: "I didn't catch that.",
            started: [],
            heard: "",
          };
        }
        if (circe === undefined) return { ...unavailable, heard: heard.success };
        const reply = yield* say({
          utterance: heard.success,
          ...(input.focus === undefined ? {} : { focus: input.focus }),
          ...(input.origin === undefined ? {} : { origin: input.origin }),
          ...(input.presentedComputerRequest === undefined
            ? {}
            : { presentedComputerRequest: input.presentedComputerRequest }),
        });
        return { ...reply, heard: heard.success };
      });

    const transcribe = (
      input: CirceHostTranscribeInput,
    ): Effect.Effect<CirceHostTranscribeResult> =>
      Effect.gen(function* () {
        const heard = yield* voice
          .transcribe({
            audio: input.audio,
            mimeType: input.mimeType,
            vocabulary: yield* vocabulary,
          })
          .pipe(Effect.result);
        if (heard._tag === "Failure") {
          return { status: "failed", message: heard.failure.reason } as const;
        }
        return { status: "heard", heard: heard.success } as const;
      });

    return CirceHostRuntime.of({
      say,
      listen,
      transcribe,
      speak: (input) =>
        voice
          .speak(input.text)
          .pipe(
            Effect.catchTag("CirceHostOperationError", (error) =>
              Effect.logWarning("Circe host speech failed", { reason: error.reason }).pipe(
                Effect.as({ audio: "", mimeType: "audio/mpeg" as const }),
              ),
            ),
          ),
      notices: Stream.fromPubSub(hub),
    });
  }),
);
