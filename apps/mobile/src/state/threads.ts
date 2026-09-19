import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
  ThreadSnapshotLoader,
} from "@circe/client/state/threads";
import type { EnvironmentId, OrchestrationSessionStatus, ThreadId } from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "@circe/client/connection";
import { createEnvironmentCommand } from "@circe/client/state/runtime";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

export type MobileThreadLookup =
  | {
      readonly status: "found";
      readonly sessionStatus: OrchestrationSessionStatus | null;
      readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
    }
  | { readonly status: "missing" }
  | { readonly status: "unreachable" };

/** Read one durable thread through the ordinary snapshot endpoint.
 *
 * A transport failure stays "unreachable" so reconnects do not discard a
 * retained Circe listener. A confirmed 404 is "missing" and can retire it.
 */
/**
 * Durable liveness comes from the V2 projection: the active provider session's
 * status and the newest provider turn of this thread's provider thread. A
 * waiting session is still active (it is blocked on approval or input), and a
 * pending or cancelled turn must not read as finished work.
 */
function sessionStatusFromProjection(
  status: "starting" | "ready" | "running" | "waiting" | "stopped" | "error",
): NonNullable<Extract<MobileThreadLookup, { status: "found" }>["sessionStatus"]> {
  switch (status) {
    case "starting":
      return "starting";
    case "ready":
      return "ready";
    case "running":
    case "waiting":
      return "running";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function turnStateFromProjection(
  status: "pending" | "running" | "completed" | "interrupted" | "failed" | "cancelled",
): NonNullable<Extract<MobileThreadLookup, { status: "found" }>["latestTurnState"]> {
  switch (status) {
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "failed":
      return "error";
  }
}

export const lookupThread = createEnvironmentCommand(connectionAtomRuntime, {
  label: "mobile:environment-data:thread:lookup",
  execute: ({ threadId }: { readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) return { status: "unreachable" } as const;
      const loader = yield* ThreadSnapshotLoader;
      if (loader.lookup === undefined) return { status: "unreachable" } as const;
      return yield* loader.lookup(prepared.value, threadId).pipe(
        Effect.map((result): MobileThreadLookup => {
          if (result._tag === "missing") return { status: "missing" };
          const projection = result.snapshot.projection;
          const providerThreads = projection.providerThreads.filter(
            (candidate) => candidate.appThreadId === threadId,
          );
          const providerThread =
            providerThreads.find(
              (candidate) => candidate.id === projection.thread.activeProviderThreadId,
            ) ?? providerThreads.at(-1);
          const session =
            providerThread?.providerSessionId === null ||
            providerThread?.providerSessionId === undefined
              ? undefined
              : projection.providerSessions.find(
                  (candidate) => candidate.id === providerThread.providerSessionId,
                );
          const latestTurn =
            providerThread === undefined
              ? undefined
              : projection.providerTurns
                  .filter((candidate) => candidate.providerThreadId === providerThread.id)
                  .reduce<(typeof projection.providerTurns)[number] | undefined>(
                    (newest, candidate) =>
                      newest === undefined || candidate.ordinal > newest.ordinal
                        ? candidate
                        : newest,
                    undefined,
                  );
          return {
            status: "found",
            sessionStatus:
              session === undefined ? null : sessionStatusFromProjection(session.status),
            latestTurnState:
              latestTurn === undefined ? null : turnStateFromProjection(latestTurn.status),
          };
        }),
        Effect.catch(() => Effect.succeed({ status: "unreachable" } as const)),
      );
    }),
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  const state = Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
  return state;
}
