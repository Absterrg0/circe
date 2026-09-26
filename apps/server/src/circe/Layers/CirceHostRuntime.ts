import {
  ProjectId,
  ThreadId,
  type CirceHostFocus,
  type CirceHostListenInput,
  type CirceHostListenResult,
  type CirceHostNotice,
  type CirceHostSayInput,
  type CirceHostSayResult,
  type OrchestrationV2DomainEvent,
} from "@circe/contracts";
import type { DecisionRequest } from "@circe/core/decision";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import {
  loadCirceCore,
  type CirceCore,
  type Focus,
  type Jev,
  type JevRequest,
  type JevResponse,
} from "../host/core.ts";
import { makeNodeHost } from "../host/nodeHost.ts";
import { makeNodeVoice } from "../host/nodeVoice.ts";
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
    const decision = yield* CirceDecision;
    const host = yield* makeNodeHost;
    const voice = yield* makeNodeVoice;
    const context = yield* Effect.context<never>();
    const run = <A>(effect: Effect.Effect<A>) => Effect.runPromiseWith(context)(effect);

    // Every Circe turn waits on these calls, so the user's own TypeSafe key
    // (TYPESAFE_API_KEY or ~/.config/circe/typesafe-key) is used directly
    // when there is one: the relay adds about a second per call. Without
    // one, the node's own route: its configured key, or the linked relay.
    const fs = yield* FileSystem.FileSystem;
    const home = yield* Config.string("HOME").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const ownKey =
      (yield* Config.string("TYPESAFE_API_KEY").pipe(
        Config.withDefault(""),
        Effect.orElseSucceed(() => ""),
      )).length > 0 ||
      (home.length > 0 &&
        (yield* fs
          .exists(path.join(home, ".config", "circe", "typesafe-key"))
          .pipe(Effect.orElseSucceed(() => false))));
    const routedJev = (core: CirceCore): Jev => {
      const direct = core.httpJev();
      return {
        async ask(request) {
          if (ownKey) return direct.ask(request);
          const started = performance.now();
          const outcome = await run(decision.decide(request as unknown as DecisionRequest));
          if (outcome.status === "answered") {
            return checked(request, {
              model: outcome.model,
              answers: outcome.answers as JevResponse["answers"],
              usage: { input_tokens: 0, output_tokens: 0 },
              latencyMs: performance.now() - started,
              cached: false,
            });
          }
          if (outcome.reason === "decision-timeout")
            throw new core.JevTimeoutError("TypeSafe did not answer in time");
          throw new Error(`TypeSafe declined: ${outcome.reason}`);
        },
      };
    };

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
    circe?.onNotice((text) => {
      void run(
        crypto.randomUUIDv4.pipe(
          Effect.orDie,
          Effect.flatMap((id) => PubSub.publish(hub, { id, text })),
        ),
      );
    });

    // Owned like the presentation pump: the fiber dies with this layer.
    const pumpScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    if (circe !== undefined) {
      yield* Effect.promise(() => circe.refresh().catch(() => []));
      const pump = orchestrator.streamDomainEvents.pipe(
        Stream.filter((event) => STATE_EVENTS.has(event.type)),
        Stream.debounce(Duration.millis(300)),
        Stream.runForEach(() =>
          Effect.promise(() => circe.refresh()).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Circe host refresh failed", { cause })),
          ),
        ),
      );
      yield* withPresentationResubscribe(pump).pipe(Effect.forkIn(pumpScope));
    }

    /**
     * Where the client should go. The coding UI has no page for a project on
     * its own, so opening a project shows its most recent thread.
     */
    const screenFor = (focus: Focus | undefined) =>
      Effect.promise(async (): Promise<CirceHostFocus | undefined> => {
        if (focus === undefined) return undefined;
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

    const say = (input: CirceHostSayInput): Effect.Effect<CirceHostSayResult> =>
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
                  started: reply.started.map((threadId) => ThreadId.make(threadId)),
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
        if (circe === undefined) return { ...unavailable, heard: "" };
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
        const reply = yield* say({
          utterance: heard.success,
          ...(input.focus === undefined ? {} : { focus: input.focus }),
        });
        return { ...reply, heard: heard.success };
      });

    return CirceHostRuntime.of({
      say,
      listen,
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

/** A response that answers every question asked, with the type asked; anything else is a failed call. */
function checked(request: JevRequest, response: JevResponse): JevResponse {
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (answer === undefined) throw new Error(`TypeSafe omitted answer ${id}`);
    if (answer.type !== question.type)
      throw new Error(`TypeSafe answered ${id} with ${answer.type}, expected ${question.type}`);
  }
  return response;
}
