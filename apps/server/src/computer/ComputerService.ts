import * as NodeCrypto from "node:crypto";

import {
  type ComputerHostBootstrap,
  type ComputerHostStatus,
  type ComputerHostToolResult,
} from "@circe/contracts";
import { HostProcessPlatform } from "@circe/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { ServerConfig } from "../config.ts";
import {
  ComputerHostTransport,
  ComputerHostTransportError,
  type ComputerHostTransportState,
} from "./ComputerHostTransport.ts";

/**
 * Computer policy for one node: one active mission, tool admission, and audit.
 * The service is the only server-side owner of computer use. It never talks to
 * the Cua driver; the desktop host does that. A node with no host runs this
 * service in an unavailable state and refuses every operation.
 *
 * Three ownership rules are enforced here:
 *
 * - One mission per node. Admission is atomic, so concurrent starts cannot
 *   both observe an idle node and both be accepted.
 * - A mission has an authenticated owner. A provider session may only act
 *   under a mission that was delegated to that exact session; discovering the
 *   node's current mission grants nothing.
 * - Teardown completes before the mission is forgotten. The slot stays busy
 *   until the host acknowledges end-of-mission, so a cleared registration
 *   proves driver cleanup finished, not the other way around.
 */

const AUDIT_FILE_NAME = "computer-audit.jsonl";
const MISSION_GOAL_MAX_CHARS = 512;
const BEGIN_TIMEOUT_MS = 10_000;
const END_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

export const ComputerMissionSource = Schema.Literals(["voice", "ui", "agent"]);
export type ComputerMissionSource = typeof ComputerMissionSource.Type;

/** The authenticated origin a mission belongs to. */
export const ComputerMissionOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("client") }),
  Schema.Struct({
    kind: Schema.Literal("provider"),
    threadId: Schema.String,
    providerSessionId: Schema.String,
  }),
]);
export type ComputerMissionOwner = typeof ComputerMissionOwner.Type;

export interface ComputerMission {
  readonly id: string;
  readonly goal: string;
  readonly source: ComputerMissionSource;
  readonly owner: ComputerMissionOwner;
  readonly startedAtMs: number;
  /** The client request id that can cancel this mission, when one exists. */
  readonly requestId?: string;
}

export interface ComputerServiceStatus {
  readonly available: boolean;
  readonly host: ComputerHostStatus | undefined;
  readonly activeMission: ComputerMission | undefined;
}

export type ComputerServiceEvent =
  | { readonly type: "mission-started"; readonly mission: ComputerMission }
  | { readonly type: "mission-ended"; readonly missionId: string; readonly reason: string }
  | { readonly type: "input-interrupted"; readonly missionId: string | undefined }
  | { readonly type: "driver-exit"; readonly missionId: string | undefined }
  | { readonly type: "host-state"; readonly state: ComputerHostTransportState };

export class ComputerUnavailableError extends Schema.TaggedError<ComputerUnavailableError>()(
  "ComputerUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Computer use is unavailable: ${this.reason}`;
  }
}

export class ComputerMissionError extends Schema.TaggedError<ComputerMissionError>()(
  "ComputerMissionError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface ComputerServiceShape {
  readonly status: Effect.Effect<ComputerServiceStatus>;
  readonly beginMission: (input: {
    readonly goal: string;
    readonly source: ComputerMissionSource;
    readonly owner: ComputerMissionOwner;
    readonly requestId?: string;
  }) => Effect.Effect<ComputerMission, ComputerUnavailableError | ComputerMissionError>;
  readonly call: (input: {
    readonly missionId: string;
    readonly tool: string;
    readonly args?: unknown;
    /** When present, the mission's owner must match this authenticated origin. */
    readonly owner?: ComputerMissionOwner;
  }) => Effect.Effect<ComputerHostToolResult, ComputerUnavailableError | ComputerMissionError>;
  readonly endMission: (input: {
    readonly missionId: string;
    readonly reason: string;
  }) => Effect.Effect<void>;
  readonly stop: (missionId?: string) => Effect.Effect<void>;
  readonly events: Stream.Stream<ComputerServiceEvent>;
  readonly activeMission: Effect.Effect<ComputerMission | undefined>;
}

export class ComputerService extends Context.Service<ComputerService, ComputerServiceShape>()(
  "@absterrg0/circe/computer/ComputerService",
) {}

interface AuditEntry {
  readonly tsMs: number;
  readonly event: "mission.begin" | "mission.end" | "call";
  readonly missionId?: string;
  /** For mission.end: whether dispatched work drained before the slot released. */
  readonly settled?: boolean;
  readonly tool?: string;
  readonly owner?: string;
  readonly effect?: string;
  readonly refusalCode?: string;
  readonly durationMs?: number;
  readonly pid?: number;
  readonly windowId?: number;
}

/** The node's execution slot: idle, admitting a start, running, or tearing down. */
type MissionSlot =
  | { readonly phase: "idle" }
  | { readonly phase: "starting"; readonly mission: ComputerMission }
  | { readonly phase: "active"; readonly mission: ComputerMission }
  | { readonly phase: "ending"; readonly mission: ComputerMission };

const pickAuditTarget = (structured: unknown): { pid?: number; windowId?: number } => {
  if (typeof structured !== "object" || structured === null || Array.isArray(structured)) return {};
  const record = structured as Record<string, unknown>;
  const pid = record.pid;
  const windowId = record.window_id ?? record.windowId;
  return {
    ...(typeof pid === "number" && Number.isSafeInteger(pid) ? { pid } : {}),
    ...(typeof windowId === "number" && Number.isSafeInteger(windowId)
      ? { windowId }
      : typeof windowId === "string" && /^\d+$/.test(windowId)
        ? { windowId: Number(windowId) }
        : {}),
  };
};

const platformOf = (platform: NodeJS.Platform): "darwin" | "linux" | "win32" | "other" => {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "win32";
  return "other";
};

const ownerMatches = (
  mission: ComputerMission,
  owner: ComputerMissionOwner | undefined,
): boolean => {
  if (owner === undefined) return true;
  if (mission.owner.kind !== owner.kind) return false;
  if (mission.owner.kind === "provider" && owner.kind === "provider")
    return (
      mission.owner.threadId === owner.threadId &&
      mission.owner.providerSessionId === owner.providerSessionId
    );
  return true;
};

const ownerLabel = (owner: ComputerMissionOwner): string =>
  owner.kind === "client" ? "client" : `provider:${owner.threadId}`;

export interface ComputerServiceOptions {
  readonly stateDir: string;
  readonly computerHost: ComputerHostBootstrap | undefined;
}

const makeService = Effect.fn("computer.makeService")(function* (options: ComputerServiceOptions) {
  const hostPlatform = yield* HostProcessPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hub = yield* PubSub.unbounded<ComputerServiceEvent>();
  const slotRef = yield* SynchronizedRef.make<MissionSlot>({ phase: "idle" });
  const transportRef = yield* SynchronizedRef.make<ComputerHostTransport | undefined>(undefined);
  const auditPath = path.join(options.stateDir, AUDIT_FILE_NAME);
  const auditLock = yield* Semaphore.make(1);

  const audit = (entry: AuditEntry): Effect.Effect<void> =>
    auditLock.withPermits(1)(
      Effect.gen(function* () {
        // @effect-diagnostics-next-line preferSchemaOverJson:off - write-only JSONL audit lines.
        const line = `${JSON.stringify(entry)}\n`;
        yield* fileSystem
          .writeFileString(auditPath, line, { flag: "a" })
          .pipe(Effect.catch(() => Effect.void));
      }),
    );

  const publish = (event: ComputerServiceEvent): Effect.Effect<void> =>
    PubSub.publish(hub, event).pipe(Effect.asVoid);

  /** Release the slot only if it still belongs to this mission. */
  const releaseSlot = (missionId: string): Effect.Effect<void> =>
    SynchronizedRef.update(slotRef, (slot) =>
      slot.phase !== "idle" && slot.mission.id === missionId ? ({ phase: "idle" } as const) : slot,
    );

  const endMissionInternal = Effect.fn("computer.endMissionInternal")(function* (
    missionId: string,
    reason: string,
  ) {
    const slot = yield* SynchronizedRef.get(slotRef);
    if (slot.phase === "idle" || slot.mission.id !== missionId) return;
    // A starting mission may or may not exist at the host; end-mission is
    // idempotent and reconciles the exact admission. Everything else keeps the
    // slot busy through teardown so a new start cannot race host cleanup.
    yield* SynchronizedRef.set(slotRef, { phase: "ending", mission: slot.mission });
    const transport = yield* SynchronizedRef.get(transportRef);
    let settled: boolean | undefined;
    if (transport?.connected) {
      const reply = yield* Effect.tryPromise({
        try: () => transport.request("end-mission", { missionId }, { timeoutMs: END_TIMEOUT_MS }),
        catch: () => undefined,
      }).pipe(Effect.result);
      if (Result.isSuccess(reply) && reply.success.ok) {
        const result = reply.success.result as { readonly settled?: unknown } | undefined;
        settled = result?.settled === true;
      }
    }
    yield* releaseSlot(missionId);
    yield* audit({
      tsMs: yield* Clock.currentTimeMillis,
      event: "mission.end",
      missionId,
      ...(settled === undefined ? {} : { settled }),
    });
    yield* publish({ type: "mission-ended", missionId, reason });
  });

  const hostEventQueue = yield* Queue.unbounded<ComputerServiceEvent>();
  yield* Effect.forkScoped(
    Stream.fromQueue(hostEventQueue).pipe(
      Stream.runForEach((event) => {
        if (event.type === "driver-exit") {
          return Effect.gen(function* () {
            const slot = yield* SynchronizedRef.get(slotRef);
            if (slot.phase === "active")
              yield* endMissionInternal(slot.mission.id, "computer host exited");
            yield* publish(event);
          });
        }
        if (event.type === "host-state" && event.state !== "connected") {
          return Effect.gen(function* () {
            const slot = yield* SynchronizedRef.get(slotRef);
            if (slot.phase === "active")
              yield* endMissionInternal(slot.mission.id, "computer host disconnected");
            yield* publish(event);
          });
        }
        return publish(event);
      }),
    ),
  );

  const bootstrap = options.computerHost;
  const unavailableReason = !bootstrap
    ? "this node has no desktop computer host; start the desktop app on this machine"
    : undefined;

  if (bootstrap) {
    const transport = new ComputerHostTransport({
      bootstrap,
      platform: platformOf(hostPlatform),
      onStateChange: (state) => {
        Queue.offerUnsafe(hostEventQueue, { type: "host-state", state });
      },
      onEvent: (event) => {
        if (event.event === "input-interrupted") {
          Queue.offerUnsafe(hostEventQueue, {
            type: "input-interrupted",
            missionId: event.missionId,
          });
          return;
        }
        if (event.event === "driver-exit") {
          Queue.offerUnsafe(hostEventQueue, { type: "driver-exit", missionId: event.missionId });
        }
      },
    });
    transport.start();
    yield* SynchronizedRef.set(transportRef, transport);
    yield* Effect.addFinalizer(() => Effect.sync(() => transport.stop()));
  }

  const requireTransport = Effect.gen(function* () {
    const transport = yield* SynchronizedRef.get(transportRef);
    if (!transport || !transport.connected)
      return yield* new ComputerUnavailableError({
        reason: unavailableReason ?? "the desktop computer host is not connected",
      });
    return transport;
  });

  const mapTransportError = (error: unknown) =>
    error instanceof ComputerHostTransportError && error.code === "driver-unavailable"
      ? new ComputerUnavailableError({ reason: error.message })
      : new ComputerMissionError({
          reason: error instanceof Error ? error.message : String(error),
        });

  return ComputerService.of({
    status: Effect.gen(function* () {
      const transport = yield* SynchronizedRef.get(transportRef);
      const slot = yield* SynchronizedRef.get(slotRef);
      const activeMission = slot.phase === "idle" ? undefined : slot.mission;
      if (!transport || !transport.connected)
        return {
          available: false,
          host: undefined,
          activeMission,
        } satisfies ComputerServiceStatus;
      const reply = yield* Effect.tryPromise({
        try: () => transport.request("status", {}, { timeoutMs: 5_000 }),
        catch: (error) =>
          error instanceof ComputerHostTransportError
            ? error
            : new ComputerHostTransportError("host-error", String(error)),
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const host =
        reply && reply.ok ? (reply.result as ComputerHostStatus) : (undefined as undefined);
      return {
        available: host?.available === true,
        host,
        activeMission,
      } satisfies ComputerServiceStatus;
    }),

    beginMission: (input) =>
      Effect.gen(function* () {
        const transport = yield* requireTransport;
        // Reserve the node's execution slot before contacting the host; the
        // whole read-start-store sequence is one atomic transition.
        const mission: ComputerMission = {
          id: NodeCrypto.randomUUID(),
          goal: input.goal.slice(0, MISSION_GOAL_MAX_CHARS),
          source: input.source,
          owner: input.owner,
          startedAtMs: yield* Clock.currentTimeMillis,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        };
        const reserved = yield* SynchronizedRef.modifyEffect(slotRef, (slot) =>
          slot.phase === "idle"
            ? Effect.succeed([true, { phase: "starting", mission } as MissionSlot] as const)
            : Effect.succeed([false, slot] as const),
        );
        if (!reserved)
          return yield* new ComputerMissionError({
            reason: "A computer mission is already active or starting on this node.",
          });
        const releaseStart = SynchronizedRef.update(slotRef, (slot) =>
          slot.phase === "starting" && slot.mission.id === mission.id
            ? ({ phase: "idle" } as const)
            : slot,
        );
        // An interruption while waiting for the host must not leave the slot
        // reserved: reconcile the exact admission (idempotent end-mission),
        // then release only our own reservation.
        const accepted = yield* Effect.onInterrupt(
          Effect.tryPromise({
            try: () =>
              transport.request(
                "begin-mission",
                { missionId: mission.id },
                { timeoutMs: BEGIN_TIMEOUT_MS },
              ),
            catch: mapTransportError,
          }).pipe(Effect.result),
          () =>
            Effect.gen(function* () {
              yield* Effect.tryPromise({
                try: () =>
                  transport.request(
                    "end-mission",
                    { missionId: mission.id },
                    { timeoutMs: END_TIMEOUT_MS },
                  ),
                catch: () => undefined,
              }).pipe(Effect.catch(() => Effect.void));
              yield* releaseStart;
            }),
        );
        if (accepted._tag === "Failure") {
          yield* releaseStart;
          return yield* accepted.failure;
        }
        if (!accepted.success.ok) {
          yield* releaseStart;
          return yield* new ComputerMissionError({
            reason: accepted.success.error?.message ?? "The computer host refused the mission.",
          });
        }
        yield* SynchronizedRef.set(slotRef, { phase: "active", mission });
        yield* audit({
          tsMs: mission.startedAtMs,
          event: "mission.begin",
          missionId: mission.id,
          owner: ownerLabel(mission.owner),
        });
        yield* publish({ type: "mission-started", mission });
        return mission;
      }),

    call: (input) =>
      Effect.gen(function* () {
        const transport = yield* requireTransport;
        const slot = yield* SynchronizedRef.get(slotRef);
        if (slot.phase !== "active")
          return yield* new ComputerMissionError({
            reason:
              slot.phase === "starting"
                ? "A computer mission is starting on this node; try again once it is active."
                : slot.phase === "ending"
                  ? "The computer mission is ending on this node."
                  : "No computer mission is active on this node.",
          });
        if (slot.mission.id !== input.missionId)
          return yield* new ComputerMissionError({
            reason: "That computer mission is not active on this node.",
          });
        if (!ownerMatches(slot.mission, input.owner))
          return yield* new ComputerMissionError({
            reason:
              "This computer mission was authorized for a different origin; provider calls may only act under a mission delegated to their own session.",
          });
        const startedAtMs = yield* Clock.currentTimeMillis;
        const result = yield* Effect.tryPromise({
          try: () =>
            transport.callTool({
              missionId: slot.mission.id,
              tool: input.tool,
              args: input.args,
            }),
          catch: mapTransportError,
        });
        const target = pickAuditTarget(result.structured);
        yield* audit({
          tsMs: yield* Clock.currentTimeMillis,
          event: "call",
          missionId: slot.mission.id,
          tool: input.tool,
          owner: ownerLabel(slot.mission.owner),
          effect: result.effect,
          ...(result.refusalCode ? { refusalCode: result.refusalCode } : {}),
          durationMs: (yield* Clock.currentTimeMillis) - startedAtMs,
          ...target,
        });
        return result;
      }),

    endMission: (input) => endMissionInternal(input.missionId, input.reason),

    stop: (missionId) =>
      Effect.gen(function* () {
        const transport = yield* SynchronizedRef.get(transportRef);
        const slot = yield* SynchronizedRef.get(slotRef);
        const mission = slot.phase === "idle" ? undefined : slot.mission;
        const target = missionId ?? mission?.id;
        if (transport?.connected) {
          yield* Effect.tryPromise({
            try: () =>
              transport.request(
                "stop",
                { ...(target ? { missionId: target } : {}), reason: "user-stop" },
                { timeoutMs: STOP_TIMEOUT_MS },
              ),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.void));
        }
        if (target) yield* endMissionInternal(target, "stopped");
      }),

    events: Stream.fromPubSub(hub),

    activeMission: SynchronizedRef.get(slotRef).pipe(
      Effect.map((slot) => (slot.phase === "idle" ? undefined : slot.mission)),
    ),
  });
});

const make = Effect.fn("computer.make")(function* () {
  const config = yield* ServerConfig;
  return yield* makeService({ stateDir: config.stateDir, computerHost: config.computerHost });
});

export const layer = Layer.effect(ComputerService, make());

/** Direct-construction layer for tests that already own a host endpoint and state dir. */
export const layerTest = (options: ComputerServiceOptions) =>
  Layer.effect(ComputerService, makeService(options));
