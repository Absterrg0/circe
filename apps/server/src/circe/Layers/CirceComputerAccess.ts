import type {
  CirceComputerAccessView,
  CirceComputerRequestView,
  CirceComputerUseResult,
  CirceDeviceTarget,
  OrchestrationV2DomainEvent,
  RunId,
} from "@circe/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ComputerService } from "../../computer/ComputerService.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import {
  CirceComputerAccess,
  CirceComputerAccessError,
  type CirceComputerAccessState,
  type CirceComputerAgent,
  type CirceComputerDecisionSource,
  type CirceComputerGrant,
  type CirceComputerOutcome,
  type CirceComputerRequest,
  type CirceComputerRequester,
} from "../Services/CirceComputerAccess.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";
import { withResubscribe } from "../../streamResubscribe.ts";

const GOAL_MAX_CHARS = 1_000;
/** How long a stop waits for Circe's executor to release the computer before interrupting it. */
const STOP_SETTLE_MS = 10_000;
/** How long a released executor gets to report how it stopped. */
const STOP_JOIN_MS = 2_000;

const TERMINAL_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

const UNREPORTED =
  "It stopped before reporting back, so part of it may have happened. Check the screen.";
const RUN_ENDED = "The agent's run ended before you answered.";

const refuse = (reason: string) => Effect.fail(new CirceComputerAccessError({ reason }));

const isSession = (requester: CirceComputerRequester, providerSessionId: string) =>
  requester.kind === "agent" && requester.providerSessionId === providerSessionId;

const isRun = (requester: CirceComputerRequester, runId: string) =>
  requester.kind === "agent" && requester.runId === runId;

/**
 * Whether two requesters are the same asker: the same device session, or the
 * same agent run. Only the same asker may replace a waiting request, so a yes
 * is never spent on a question its speaker did not hear.
 */
const sameAsker = (left: CirceComputerRequester, right: CirceComputerRequester) =>
  left.kind === "user"
    ? right.kind === "user" && left.origin === right.origin
    : right.kind === "agent" &&
      left.providerSessionId === right.providerSessionId &&
      left.runId === right.runId;

/** What an executor result means for the user. Only a finished goal is a success. */
function outcomeOf(result: CirceComputerUseResult): CirceComputerOutcome {
  switch (result.status) {
    case "done":
      return "completed";
    case "cancelled":
      return "stopped";
    default:
      return "failed";
  }
}

function requestView(request: CirceComputerRequest): CirceComputerRequestView {
  return {
    id: request.id,
    goal: request.goal,
    requester:
      request.requester.kind === "user"
        ? { kind: "user" }
        : {
            kind: "agent",
            threadId: request.requester.threadId,
            title: request.requester.title.slice(0, 300),
          },
    at: request.at,
  };
}

const baseRequest = (active: NonNullable<CirceComputerAccessState["active"]>) => ({
  id: active.id,
  goal: active.goal,
  requester: active.requester,
  at: active.at,
  cancelId: active.cancelId,
});

export const CirceComputerAccessLive = Layer.effect(
  CirceComputerAccess,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const computer = yield* ComputerService;
    const executor = yield* CirceComputerUse;
    const cancellation = yield* CirceMissionCancellation;
    const orchestrator = yield* OrchestratorV2;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const crypto = yield* Crypto.Crypto;
    const controllable = (config.circeNodePreset ?? "full") !== "headless";
    const ref = yield* SubscriptionRef.make<CirceComputerAccessState>({
      pending: null,
      active: null,
      last: null,
    });
    // Executor runs and the holder watch belong to the node, not to the
    // request that approved them: they settle when the layer closes, never
    // when a client disconnects.
    const scope = yield* Effect.acquireRelease(Scope.make(), (owned) =>
      Scope.close(owned, Exit.void),
    );
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
    const executorRuns = new Map<string, Fiber.Fiber<CirceComputerUseResult>>();

    /** Records how the active request ended; a request that is no longer active changes nothing. */
    const settle = (requestId: string, outcome: CirceComputerOutcome, message: string) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* SubscriptionRef.update(ref, (state) =>
          state.active?.id === requestId
            ? {
                ...state,
                active: null,
                last: { request: baseRequest(state.active), outcome, message, at },
              }
            : state,
        );
      });

    /** Moves the waiting request to `last` when it is the one `matches` names. */
    const withdrawPending = (
      matches: (request: CirceComputerRequest) => boolean,
      outcome: CirceComputerOutcome,
      message: string,
    ) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        return yield* SubscriptionRef.modify(ref, (state) =>
          state.pending !== null && matches(state.pending)
            ? ([
                true,
                {
                  ...state,
                  pending: null,
                  last: { request: state.pending, outcome, message, at },
                },
              ] as const)
            : ([false, state] as const),
        );
      });

    /** The id the executor registers for cancellation: the client's own, when it minted one. */
    const stopIdOf = (request: CirceComputerRequest) =>
      request.cancelId ?? `computer-access:${request.id}`;

    /**
     * Whether the computer can be used now (`reason` says why not), and what
     * an otherwise usable computer cannot do. Screen reading is a limitation,
     * not a blocker: accessible apps keep working without it.
     */
    const availability = Effect.gen(function* () {
      if (!controllable)
        return { reason: "This node has no desktop to control.", limitation: undefined };
      const status = yield* computer.status;
      if (!status.available)
        return {
          reason:
            status.host?.reason ??
            "Computer use needs the Circe desktop app running on this node, with its desktop session connected.",
          limitation: undefined,
        };
      return {
        reason: null,
        limitation:
          status.host?.capabilities.visualGrounding === false
            ? "Circe can't read apps that draw their own controls on this computer, so it works only in apps that expose accessibility controls."
            : undefined,
      };
    });
    const unavailableReason = availability.pipe(Effect.map((current) => current.reason));

    const cleanGoal = (goal: string) => goal.replace(/\s+/gu, " ").trim().slice(0, GOAL_MAX_CHARS);

    const request = Effect.fn("CirceComputerAccess.request")(function* (input: {
      readonly goal: string;
      readonly requester: CirceComputerRequester;
    }) {
      const goal = cleanGoal(input.goal);
      if (goal.length === 0) return yield* refuse("say what to do on the computer");
      const reason = yield* unavailableReason;
      if (reason !== null) return yield* refuse(reason);
      // An agent whose run already ended holds nothing and waits on nothing.
      yield* reconcileAgents;
      const { requester } = input;
      const candidate: CirceComputerRequest = {
        id: yield* newId,
        goal,
        requester,
        at: yield* nowIso,
        cancelId: null,
      };
      // Admission is one transition: two requests racing each other see the
      // same slot, and exactly one of them decides what it holds.
      const admitted = yield* SubscriptionRef.modify(
        ref,
        (
          state,
        ): readonly [
          (
            | { readonly kind: "request"; readonly request: CirceComputerRequest }
            | { readonly kind: "refused"; readonly reason: string }
          ),
          CirceComputerAccessState,
        ] => {
          if (state.active !== null) {
            // The agent run that holds the computer keeps using its mission
            // for the approved goal. A changed goal needs its own approval,
            // so it waits for the current one to finish instead of spending
            // the existing grant on different work.
            if (requester.kind === "agent" && sameAsker(state.active.requester, requester)) {
              return state.active.goal === goal
                ? [{ kind: "request", request: baseRequest(state.active) }, state]
                : [
                    {
                      kind: "refused",
                      reason: `you hold the computer for "${state.active.goal}"; finish that first`,
                    },
                    state,
                  ];
            }
            return [
              {
                kind: "refused",
                reason: `the computer is busy with "${state.active.goal}"; stop that first`,
              },
              state,
            ];
          }
          if (state.pending !== null) {
            // The same agent asking again waits on the same request; a
            // different goal from it would turn an answer given to the first
            // into consent for the second.
            if (requester.kind === "agent" && sameAsker(state.pending.requester, requester)) {
              return state.pending.goal === goal
                ? [{ kind: "request", request: state.pending }, state]
                : [
                    {
                      kind: "refused",
                      reason: `you already asked for the computer to "${state.pending.goal}"; wait for that answer`,
                    },
                    state,
                  ];
            }
            // Only the device that asked may correct its own waiting request.
            if (requester.kind === "agent" || !sameAsker(state.pending.requester, requester)) {
              return [
                {
                  kind: "refused",
                  reason: `the computer is waiting on an answer to "${state.pending.goal}"; answer or cancel that first`,
                },
                state,
              ];
            }
          }
          // A new goal replaces one still waiting and needs its own approval:
          // correcting a request never approves it.
          return [
            { kind: "request", request: candidate },
            {
              ...state,
              pending: candidate,
              ...(state.pending === null
                ? {}
                : {
                    last: {
                      request: state.pending,
                      outcome: "declined" as const,
                      message: "Replaced by a newer request.",
                      at: candidate.at,
                    },
                  }),
            },
          ];
        },
      );
      if (admitted.kind === "refused") return yield* refuse(admitted.reason);
      return admitted.request;
    });

    /** Circe's executor carries out an approved goal; every exit settles the request. */
    const startExecutor = (approved: CirceComputerRequest, target?: CirceDeviceTarget) =>
      Effect.gen(function* () {
        const nodeId = yield* environment.getEnvironmentId;
        return yield* executor.run({
          goal: approved.goal,
          ...(approved.options?.typeText === undefined
            ? {}
            : { typeText: approved.options.typeText }),
          ...(approved.options?.maxSteps === undefined
            ? {}
            : { maxSteps: approved.options.maxSteps }),
          confirmed: true,
          requestMetadata: { requestId: stopIdOf(approved) },
          target: target ?? { nodeId, surface: "computer" },
        });
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? settle(approved.id, outcomeOf(exit.value), exit.value.message)
            : settle(approved.id, "uncertain", UNREPORTED),
        ),
        Effect.ensuring(Effect.sync(() => executorRuns.delete(approved.id))),
        Effect.forkIn(scope),
        Effect.tap((fiber) => Effect.sync(() => executorRuns.set(approved.id, fiber))),
      );

    /**
     * Hands the agent a mission owned by its own provider session. A request
     * withdrawn while the mission was being admitted gets that exact mission
     * ended at once, so no native mission outlives its owner.
     */
    const delegate = (approved: CirceComputerRequest, agent: CirceComputerAgent) =>
      Effect.gen(function* () {
        const begun = yield* computer
          .beginMission({
            goal: approved.goal,
            source: "agent",
            owner: {
              kind: "provider",
              threadId: agent.threadId,
              providerSessionId: agent.providerSessionId,
            },
            requestId: stopIdOf(approved),
          })
          .pipe(Effect.result);
        if (begun._tag === "Failure") {
          yield* settle(approved.id, "failed", begun.failure.message);
          return yield* refuse(begun.failure.message);
        }
        const mission = begun.success;
        const kept = yield* SubscriptionRef.modify(ref, (state) =>
          state.active?.id === approved.id
            ? ([true, { ...state, active: { ...state.active, missionId: mission.id } }] as const)
            : ([false, state] as const),
        );
        if (!kept) {
          yield* computer.endMission({
            missionId: mission.id,
            reason: "withdrawn while starting",
          });
          return yield* refuse("the request was withdrawn before the computer was ready");
        }
      });

    /** Whether the agent's run that asked is still the thread's running one. */
    const runIsLive = (agent: CirceComputerAgent) =>
      orchestrator.getThreadShell(agent.threadId).pipe(
        Effect.map((shell) => shell !== null && shell.activeRunId === agent.runId),
        Effect.orElseSucceed(() => false),
      );

    /**
     * Releases an agent's hold and withdraws an agent's waiting request when
     * the run that asked is no longer running. Run-end events do this as they
     * arrive; this catches any the event stream missed.
     */
    const reconcileAgents = Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(ref);
      const pending = state.pending;
      if (pending !== null && pending.requester.kind === "agent") {
        if (!(yield* runIsLive(pending.requester))) {
          yield* withdrawPending((candidate) => candidate.id === pending.id, "declined", RUN_ENDED);
        }
      }
      const active = state.active;
      if (active !== null && active.requester.kind === "agent") {
        if (!(yield* runIsLive(active.requester))) {
          if (active.missionId !== null) {
            yield* computer.endMission({
              missionId: active.missionId,
              reason: "the agent's run ended",
            });
          }
          yield* settle(
            active.id,
            "released",
            "The agent's run ended, so it handed the computer back.",
          );
        }
      }
    });

    const holds = (agent: { readonly providerSessionId: string; readonly runId: RunId | null }) =>
      Effect.gen(function* () {
        const active = (yield* SubscriptionRef.get(ref)).active;
        if (active === null || !isSession(active.requester, agent.providerSessionId)) return false;
        if (agent.runId !== null && isRun(active.requester, agent.runId)) {
          return active.missionId !== null;
        }
        // Same session, another run (or none): the grant belonged to a run that ended.
        yield* reconcileAgents;
        return false;
      });

    const decide = Effect.fn("CirceComputerAccess.decide")(function* (
      requestId: string,
      decision: "approve" | "deny",
      source: CirceComputerDecisionSource,
    ) {
      const current = (yield* SubscriptionRef.get(ref)).pending;
      if (current?.id !== requestId) return yield* refuse("that request is no longer waiting");
      if (
        source.kind === "spoken" &&
        current.requester.kind === "user" &&
        current.requester.origin !== source.origin
      ) {
        return yield* refuse(
          `the computer is waiting on "${current.goal}" from another device; answer it there or in the Computer panel`,
        );
      }

      if (decision === "deny") {
        yield* withdrawPending(
          (pending) => pending.id === requestId,
          "declined",
          "The user declined.",
        );
        return;
      }
      if (current.requester.kind === "agent" && !(yield* runIsLive(current.requester))) {
        yield* withdrawPending((pending) => pending.id === requestId, "declined", RUN_ENDED);
        return yield* refuse(RUN_ENDED);
      }
      // An agent's request reaches every device. A spoken yes counts only
      // when the speaker's device was showing this exact request: one that
      // replaced the request it heard gets no consent it was never given.
      if (
        source.kind === "spoken" &&
        current.requester.kind === "agent" &&
        source.presented !== requestId
      ) {
        return yield* refuse(
          `"${current.requester.title}" is waiting to use the computer for "${current.goal}"; approve it on the Computer card`,
        );
      }
      const at = yield* nowIso;
      // Taking the request and handing it to its executor happen together, and
      // both executors belong to the node: a requester that disconnects here
      // never leaves the computer marked busy with nothing running.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const taken = yield* SubscriptionRef.modify(ref, (state) => {
            if (state.pending?.id !== requestId || state.active !== null) {
              return [null, state] as const;
            }
            const pending = state.pending;
            return [
              pending,
              { ...state, pending: null, active: { ...pending, startedAt: at, missionId: null } },
            ] as const;
          });
          if (taken === null) return yield* refuse("that request is no longer waiting");
          if (taken.requester.kind === "agent") {
            const admission = yield* delegate(taken, taken.requester).pipe(Effect.forkIn(scope));
            return yield* restore(Fiber.join(admission));
          }
          yield* startExecutor(taken);
        }),
      );
    });

    const run = Effect.fn("CirceComputerAccess.run")(function* (input: {
      readonly goal: string;
      readonly cancelId?: string;
      readonly target?: CirceDeviceTarget;
      readonly origin?: string;
      readonly typeText?: string;
      readonly maxSteps?: number;
    }) {
      const reason = yield* unavailableReason;
      if (reason !== null) return { status: "unavailable", message: reason } as const;
      const goal = cleanGoal(input.goal);
      if (goal.length === 0) {
        return { status: "refused", message: "Say what to do on the computer." } as const;
      }
      const at = yield* nowIso;
      const approved: CirceComputerRequest = {
        id: yield* newId,
        goal,
        requester: { kind: "user", origin: input.origin ?? null },
        at,
        cancelId: input.cancelId ?? null,
        options: {
          ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
          ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
        },
      };
      const started = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const busyWith = yield* SubscriptionRef.modify(ref, (state) => {
            if (state.active !== null) return [state.active.goal, state] as const;
            return [
              null,
              {
                pending: null,
                active: { ...approved, startedAt: at, missionId: null },
                last:
                  state.pending === null
                    ? state.last
                    : {
                        request: state.pending,
                        outcome: "declined" as const,
                        message: "Replaced by a newer request.",
                        at,
                      },
              },
            ] as const;
          });
          if (busyWith !== null) return { busyWith } as const;
          return { fiber: yield* startExecutor(approved, input.target) } as const;
        }),
      );
      if ("busyWith" in started) {
        return {
          status: "refused",
          message: `The computer is busy with "${started.busyWith}". Stop that first.`,
        } as const;
      }
      const exit = yield* Fiber.await(started.fiber);
      return Exit.isSuccess(exit)
        ? exit.value
        : ({ status: "refused", message: UNREPORTED } as const);
    });

    const stopExecutor = (active: CirceComputerRequest) =>
      Effect.gen(function* () {
        // The executor stops at its next step and settles itself; interrupting
        // is the fallback when it does not let go in time.
        const stopId = stopIdOf(active);
        yield* cancellation.requestStop(stopId);
        yield* computer.stop();
        const released = yield* cancellation.awaitSettled(stopId, STOP_SETTLE_MS);
        const fiber = executorRuns.get(active.id);
        if (fiber === undefined) return;
        const joined = released
          ? yield* Fiber.await(fiber).pipe(Effect.timeoutOption(STOP_JOIN_MS))
          : Option.none();
        if (Option.isNone(joined)) yield* Fiber.interrupt(fiber);
      });

    const stop = (requestId?: string) =>
      Effect.gen(function* () {
        const matches = (candidate: CirceComputerRequest) =>
          requestId === undefined ||
          candidate.id === requestId ||
          stopIdOf(candidate) === requestId;
        const withdrew = yield* withdrawPending(matches, "stopped", "Withdrawn before it started.");
        const active = (yield* SubscriptionRef.get(ref)).active;
        if (active === null || !matches(active)) return withdrew;
        if (active.requester.kind === "agent") {
          // A mission still being admitted is ended by its admission, which
          // sees that the request is no longer active.
          if (active.missionId !== null) yield* computer.stop(active.missionId);
          yield* settle(active.id, "stopped", "Stopped by the user.");
          return true;
        }
        yield* stopExecutor(active);
        return true;
      });

    const grantOf = (
      state: CirceComputerAccessState,
      requester: CirceComputerAgent,
      requestId: string,
    ): CirceComputerGrant | undefined => {
      const active = state.active;
      if (active !== null && sameAsker(active.requester, requester)) {
        return active.missionId === null
          ? undefined
          : { status: "granted", missionId: active.missionId };
      }
      if (state.pending?.id === requestId) return undefined;
      if (state.last?.request.id === requestId) {
        return { status: "declined", message: state.last.message };
      }
      return { status: "declined", message: "The request was withdrawn." };
    };

    const awaitGrant = (
      requester: CirceComputerAgent,
      requestId: string,
      timeout: Duration.Input,
    ) =>
      SubscriptionRef.changes(ref).pipe(
        Stream.map((state) => grantOf(state, requester, requestId)),
        Stream.filter((grant): grant is CirceComputerGrant => grant !== undefined),
        Stream.runHead,
        Effect.timeoutOption(timeout),
        Effect.map((found): CirceComputerGrant =>
          Option.isSome(found) && Option.isSome(found.value)
            ? found.value.value
            : { status: "waiting", requestId },
        ),
      );

    const release = (providerSessionId: string) =>
      Effect.gen(function* () {
        const active = (yield* SubscriptionRef.get(ref)).active;
        if (active === null || !isSession(active.requester, providerSessionId)) return;
        if (active.missionId !== null) {
          yield* computer.endMission({
            missionId: active.missionId,
            reason: "released by the agent",
          });
        }
        yield* settle(active.id, "released", "The agent finished with the computer.");
      });

    // An agent's access lasts as long as the exact run that asked, and a
    // held mission as long as the native mission: the end of either one
    // withdraws the request or hands the computer back.
    const holderEnded = Stream.merge(
      computer.events.pipe(
        Stream.filter((event) => event.type === "mission-ended"),
        Stream.map((event) => ({ missionId: event.missionId, reason: event.reason })),
      ),
      orchestrator.streamDomainEvents.pipe(
        Stream.filter(
          (event): event is Extract<OrchestrationV2DomainEvent, { type: "run.updated" }> =>
            event.type === "run.updated" && TERMINAL_RUN.has(event.payload.status),
        ),
        Stream.map((event) => ({ runId: event.payload.id as string })),
      ),
    );
    const watch = holderEnded.pipe(
      Stream.runForEach((ended) =>
        Effect.gen(function* () {
          if ("runId" in ended) {
            yield* withdrawPending(
              (pending) => isRun(pending.requester, ended.runId),
              "declined",
              RUN_ENDED,
            );
          }
          const active = (yield* SubscriptionRef.get(ref)).active;
          if (active === null || active.requester.kind !== "agent") return;
          if ("missionId" in ended) {
            if (ended.missionId === active.missionId) {
              yield* settle(active.id, "released", `The computer mission ended: ${ended.reason}.`);
            }
            return;
          }
          if (!isRun(active.requester, ended.runId)) return;
          if (active.missionId !== null) {
            yield* computer.endMission({
              missionId: active.missionId,
              reason: "the agent's run ended",
            });
          }
          yield* settle(
            active.id,
            "released",
            "The agent's run ended, so it handed the computer back.",
          );
        }),
      ),
    );
    // A resubscribe first catches up on any run that ended while the stream was down.
    yield* withResubscribe("Computer access holder watch", watch, {
      onResubscribe: reconcileAgents.pipe(Effect.orElseSucceed(() => undefined)),
    }).pipe(Effect.forkIn(scope));

    const toView = (
      state: CirceComputerAccessState,
      current: { readonly reason: string | null; readonly limitation: string | undefined },
    ): CirceComputerAccessView => ({
      controllable,
      available: current.reason === null,
      ...(current.reason === null ? {} : { reason: current.reason }),
      ...(current.limitation === undefined ? {} : { limitation: current.limitation }),
      pending: state.pending === null ? null : requestView(state.pending),
      active:
        state.active === null
          ? null
          : { ...requestView(state.active), startedAt: state.active.startedAt },
      last:
        state.last === null
          ? null
          : {
              request: requestView(state.last.request),
              outcome: state.last.outcome,
              message: state.last.message,
              at: state.last.at,
            },
    });

    return CirceComputerAccess.of({
      controllable,
      state: SubscriptionRef.get(ref),
      request,
      decide,
      run,
      stop,
      awaitGrant,
      holds,
      release,
      // The view follows the desktop host too: a host that connects or drops
      // is a change every client should see without asking again.
      view: Stream.merge(
        SubscriptionRef.changes(ref).pipe(Stream.map((): void => undefined)),
        computer.events.pipe(
          Stream.filter((event) => event.type === "host-state"),
          Stream.map((): void => undefined),
        ),
      ).pipe(
        Stream.mapEffect(() =>
          Effect.all([SubscriptionRef.get(ref), availability]).pipe(
            Effect.map(([state, current]) => toView(state, current)),
          ),
        ),
      ),
      changes: SubscriptionRef.changes(ref).pipe(Stream.map((): void => undefined)),
    });
  }),
);
