import {
  CirceInteractionError,
  CirceInteractionId,
  type AuthSessionId,
  type ProjectId,
  type ThreadId,
  CirceInteractionState,
  CirceInteractionSubmitResult,
  CirceOperation,
  CirceOperationId,
  type CirceDeviceReadiness,
  type CirceDeviceSurfaceReadiness,
  type CirceInteractionGoal,
  type CirceInteractionInterruptInput,
  type CirceInteractionInterruptResult,
  type CirceInteractionSubmitInput,
  type EnvironmentId,
} from "@circe/contracts";
import type { CirceBrowserUseResult, CirceSemanticProposal } from "@circe/contracts";
import type { DecisionRequest } from "@circe/core/decision";
import {
  askCirceQuestion,
  bindCirceDeviceTarget,
  buildInteractionRelationRequest,
  circeLookupSourceUtterance,
  createLookupInteraction,
  decideCirceInteractionInput,
  deviceApprovalQuestion,
  needsRelationDecision,
  readInteractionRelation,
  recordCirceOutcome,
  type CirceLookupGoal,
} from "@circe/core/interaction";
import * as DateTime from "effect/DateTime";
import { FetchHttpClient } from "effect/unstable/http";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { randomUuidV4 } from "../../orchestration-v2/RandomUuid.ts";
import { isPersistenceError } from "../../persistence/Errors.ts";
import { ComputerService } from "../../computer/ComputerService.ts";
import * as CirceBrowserUse from "../Services/CirceBrowserUse.ts";
import { CirceBrowserConnector } from "../Services/CirceBrowserConnector.ts";
import { CirceBrowserConnectorUse } from "../Services/CirceBrowserConnectorUse.ts";
import { CirceComputerAccess } from "../Services/CirceComputerAccess.ts";
import * as CirceController from "../Services/CirceController.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceInteraction } from "../Services/CirceInteraction.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";
import { runCirceLookup, type CirceLookupOutcome } from "../Services/CirceQuickLookup.ts";

const DECISION_MODEL = "jev-latest";
const MAX_PROJECTS = 64;

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(CirceInteractionState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(CirceInteractionState));
const decodeResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CirceInteractionSubmitResult),
);
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(CirceInteractionSubmitResult));

const StoredOperationSchema = Schema.Struct({
  operation: CirceOperation,
  /** Mission cancellation identity; internal, never part of the wire contract. */
  requestId: Schema.String,
});
type StoredOperation = typeof StoredOperationSchema.Type;
const decodeStoredOperation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredOperationSchema),
);
const encodeStoredOperation = Schema.encodeEffect(Schema.fromJsonString(StoredOperationSchema));

const interactionError = (code: CirceInteractionError["code"], message: string) =>
  new CirceInteractionError({ code, message });

const toInteractionError = (operation: string, cause: unknown): CirceInteractionError =>
  interactionError(
    "dispatch-failed",
    isPersistenceError(cause) ? `Circe could not ${operation}.` : `Circe could not ${operation}.`,
  );

const newInteractionId = randomUuidV4.pipe(Effect.map((uuid) => CirceInteractionId.make(uuid)));
const newOperationId = randomUuidV4.pipe(Effect.map((uuid) => CirceOperationId.make(uuid)));

type DirectGoal =
  | {
      readonly kind: "lookup";
      readonly tool: "weather" | "time";
      readonly day: CirceLookupGoal["day"];
      readonly location?: string;
    }
  | {
      readonly kind: "device";
      readonly surface: "browser" | "preview" | "computer";
      readonly goal: string;
      readonly requiresApproval: boolean;
    };

/** Which direct operation a classified proposal authorizes, if any. */
function directGoalFromProposal(proposal: {
  readonly action: string;
  readonly lookup?:
    | {
        readonly kind?: "weather" | "time";
        readonly day?: CirceLookupGoal["day"];
        readonly location?: string | null;
      }
    | null
    | undefined;
  readonly clarification?:
    | {
        readonly kind: string;
        readonly tool?: "weather" | "time";
        readonly day?: CirceLookupGoal["day"];
      }
    | null
    | undefined;
  readonly browserGoal?: string | null | undefined;
  readonly computerGoal?: string | null | undefined;
}): DirectGoal | null {
  // A weather or time request is a direct lookup whatever shape the proposal
  // takes: an `action: lookup` with or without a resolved place, or an
  // `unsupported` action carrying a lookup clarification. A missing place is
  // the interaction's own question, not a project request.
  const clarification = proposal.clarification;
  const lookup = proposal.lookup;
  const tool = lookup?.kind ?? (clarification?.kind === "lookup" ? clarification.tool : undefined);
  if (
    (proposal.action === "lookup" || proposal.action === "unsupported") &&
    (tool === "weather" || tool === "time")
  ) {
    const day = lookup?.day ?? (clarification?.kind === "lookup" ? clarification.day : undefined);
    const location = lookup?.location;
    return {
      kind: "lookup",
      tool,
      day: day ?? "now",
      ...(typeof location === "string" && location.length > 0 ? { location } : {}),
    };
  }
  if (proposal.action === "browse" && typeof proposal.browserGoal === "string")
    return {
      kind: "device",
      surface: "browser",
      goal: proposal.browserGoal,
      requiresApproval: false,
    };
  if (proposal.action === "preview" && typeof proposal.browserGoal === "string")
    return {
      kind: "device",
      surface: "preview",
      goal: proposal.browserGoal,
      requiresApproval: false,
    };
  if (proposal.action === "computer" && typeof proposal.computerGoal === "string")
    return {
      kind: "device",
      surface: "computer",
      goal: proposal.computerGoal,
      requiresApproval: true,
    };
  return null;
}

type OperationStatus = CirceOperation["status"];
type OperationResult = CirceOperation["lastResult"];
type OutcomeStatus = NonNullable<CirceInteractionState["outcome"]>["status"];

const missionStatus = (status: string): { status: OperationStatus; result: OperationResult } => {
  switch (status) {
    case "done":
      return { status: "completed", result: "applied" };
    case "cancelled":
      return { status: "stopped", result: "not-applied" };
    case "budget":
      return { status: "blocked", result: "unknown" };
    case "needs-input":
      return { status: "needs-input", result: "blocked" };
    case "refused":
      return { status: "blocked", result: "blocked" };
    case "unavailable":
      return { status: "blocked", result: "blocked" };
    default:
      return { status: "outcome-unknown", result: "unknown" };
  }
};

const outcomeStatusForMission = (status: OperationStatus): OutcomeStatus => {
  switch (status) {
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    case "blocked":
      return "unavailable";
    case "needs-input":
      return "needs-input";
    default:
      return "outcome-unknown";
  }
};

const emptyInteractionState = (input: {
  readonly interactionId: CirceInteractionId;
  readonly ownerNodeId: EnvironmentId;
  readonly revision: number;
  readonly goal: CirceInteractionGoal;
  readonly now: DateTime.Utc;
}): CirceInteractionState => ({
  interactionId: input.interactionId,
  ownerNodeId: input.ownerNodeId,
  revision: input.revision,
  goal: input.goal,
  pending: null,
  target: null,
  operationId: null,
  outcome: null,
  updatedAt: input.now,
});

export interface CirceInteractionOptions {
  /**
   * Injectable lookup executor. Production uses the bounded Open-Meteo reader;
   * tests substitute a deterministic outcome so the interaction transition is
   * exercised without network access.
   */
  readonly lookup?: (
    goal: CirceLookupGoal,
    sourceUtterance: string,
  ) => Effect.Effect<CirceLookupOutcome, CirceInteractionError>;
  /** Injectable running-task resolver; production reads the V2 run projection. */
  readonly findRunningTask?: () => Effect.Effect<{
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
  } | null>;
  /** Injectable classifier; production uses the node's ordinary controller. */
  readonly classify?: (
    source: string,
    input: CirceInteractionSubmitInput,
    executionNodeId: EnvironmentId,
  ) => Effect.Effect<CirceSemanticProposal, CirceInteractionError>;
}

export const make = (options: CirceInteractionOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const controllerOpt = yield* Effect.serviceOption(CirceController.CirceController);
    const controller = Option.getOrUndefined(controllerOpt);
    const browserUse = yield* CirceBrowserUse.CirceBrowserUse;
    const browserConnector = yield* CirceBrowserConnector;
    const browserConnectorUse = yield* CirceBrowserConnectorUse;
    // Desktop control goes through the computer's one owner, so this route
    // and every other one see the same holder, busy state, and stop.
    const computerAccess = yield* CirceComputerAccess;
    const missionCancellation = yield* CirceMissionCancellation;
    const computerService = yield* ComputerService;
    const decisionOpt = yield* Effect.serviceOption(CirceDecision);
    const decision = Option.getOrElse(decisionOpt, () => ({
      decide: (_request: DecisionRequest) =>
        Effect.succeed({ status: "decline", reason: "decision-disabled" } as const),
    }));
    const changes = yield* PubSub.unbounded<CirceInteractionState>();
    // Accepted operations run here, not in the request that accepted them: a
    // requester that disconnects or is interrupted leaves the operation to
    // finish and settle, and closing the node settles it as unknown.
    const operationScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );

    const preset = config.circeNodePreset ?? "full";

    const readState = Effect.fn("CirceInteraction.readState")(function* (
      interactionId: CirceInteractionId,
      ownerEnvironmentId: EnvironmentId,
    ) {
      const rows = yield* sql<{ readonly stateJson: unknown }>`
        SELECT state_json AS stateJson FROM circe_interactions
        WHERE interaction_id = ${interactionId} AND owner_environment_id = ${ownerEnvironmentId}
      `.pipe(Effect.mapError((cause) => toInteractionError("load the interaction", cause)));
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeState(row.stateJson).pipe(
        Effect.mapError((cause) => toInteractionError("read the interaction", cause)),
      );
    });

    const readActive = Effect.fn("CirceInteraction.readActive")(function* (
      ownerEnvironmentId: EnvironmentId,
    ) {
      const rows = yield* sql<{ readonly stateJson: unknown }>`
        SELECT state_json AS stateJson FROM circe_interactions
        WHERE owner_environment_id = ${ownerEnvironmentId} AND active = 1
        ORDER BY updated_at DESC LIMIT 1
      `.pipe(Effect.mapError((cause) => toInteractionError("load the interaction", cause)));
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeState(row.stateJson).pipe(
        Effect.mapError((cause) => toInteractionError("read the interaction", cause)),
      );
    });

    const saveState = Effect.fn("CirceInteraction.saveState")(function* (input: {
      readonly state: CirceInteractionState;
      readonly expectedRevision: number | null;
      readonly makeActive: boolean;
    }): Effect.fn.Return<
      { readonly status: "saved" } | { readonly status: "conflict" },
      CirceInteractionError
    > {
      const { state } = input;
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly revision: unknown }>`
              SELECT revision FROM circe_interactions
              WHERE interaction_id = ${state.interactionId}
                AND owner_environment_id = ${state.ownerNodeId}
            `;
            const current = rows[0];
            if (input.expectedRevision === null) {
              if (current !== undefined) return { status: "conflict" as const };
            } else if (
              current === undefined ||
              Number(current.revision) !== input.expectedRevision
            ) {
              return { status: "conflict" as const };
            }
            const encoded = yield* encodeState(state).pipe(
              Effect.mapError((cause) => toInteractionError("save the interaction", cause)),
            );
            if (input.makeActive) {
              yield* sql`
                UPDATE circe_interactions SET active = 0
                WHERE owner_environment_id = ${state.ownerNodeId}
                  AND interaction_id != ${state.interactionId}
              `;
            }
            yield* sql`
              INSERT INTO circe_interactions(
                interaction_id, owner_environment_id, revision, active, state_json, updated_at
              ) VALUES (
                ${state.interactionId}, ${state.ownerNodeId}, ${state.revision},
                ${input.makeActive ? 1 : 0}, ${encoded}, ${DateTime.formatIso(state.updatedAt)}
              )
              ON CONFLICT(interaction_id) DO UPDATE SET
                revision = excluded.revision,
                active = MAX(active, excluded.active),
                state_json = excluded.state_json,
                updated_at = excluded.updated_at
            `;
            return { status: "saved" as const };
          }),
        )
        .pipe(Effect.mapError((cause) => toInteractionError("save the interaction", cause)));
      if (result.status === "saved") yield* PubSub.publish(changes, state);
      return result;
    });

    const saveOperation = Effect.fn("CirceInteraction.saveOperation")(function* (
      stored: StoredOperation,
    ) {
      const encoded = yield* encodeStoredOperation(stored).pipe(
        Effect.mapError((cause) => toInteractionError("save the operation", cause)),
      );
      yield* sql`
        INSERT INTO circe_operations(
          operation_id, owner_environment_id, interaction_id, status, operation_json, updated_at
        ) VALUES (
          ${stored.operation.operationId}, ${stored.operation.ownerNodeId},
          ${stored.operation.interactionId}, ${stored.operation.status}, ${encoded},
          ${DateTime.formatIso(stored.operation.updatedAt)}
        )
        ON CONFLICT(operation_id) DO UPDATE SET
          status = excluded.status,
          operation_json = excluded.operation_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError((cause) => toInteractionError("save the operation", cause)));
    });

    const readOperation = Effect.fn("CirceInteraction.readOperation")(function* (
      operationId: CirceOperationId,
    ) {
      const rows = yield* sql<{ readonly operationJson: unknown }>`
        SELECT operation_json AS operationJson FROM circe_operations
        WHERE operation_id = ${operationId}
      `.pipe(Effect.mapError((cause) => toInteractionError("load the operation", cause)));
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeStoredOperation(row.operationJson).pipe(
        Effect.mapError((cause) => toInteractionError("read the operation", cause)),
      );
    });

    const isSettledOperation = (status: CirceOperation["status"]): boolean =>
      status !== "accepted" && status !== "running" && status !== "verifying";

    const findRequest = Effect.fn("CirceInteraction.findRequest")(function* (requestId: string) {
      const rows = yield* sql<{ readonly resultJson: unknown; readonly operationId: unknown }>`
        SELECT result_json AS resultJson, operation_id AS operationId
        FROM circe_interaction_requests
        WHERE request_id = ${requestId}
      `.pipe(Effect.mapError((cause) => toInteractionError("load the request", cause)));
      const row = rows[0];
      if (row === undefined) return null;
      const stored = yield* decodeResult(row.resultJson).pipe(
        Effect.mapError((cause) => toInteractionError("read the request", cause)),
      );
      // A retry during a live mission answers with the same operation and its
      // current status; it never accepts a second effect.
      if (
        stored.status !== "operation" ||
        row.operationId === null ||
        row.operationId === undefined
      )
        return stored;
      const linked = yield* readOperation(CirceOperationId.make(String(row.operationId)));
      if (linked === null || isSettledOperation(linked.operation.status)) return stored;
      const state = yield* readState(stored.state.interactionId, stored.state.ownerNodeId);
      return {
        status: "operation",
        state: state ?? stored.state,
        operation: linked.operation,
      } satisfies CirceInteractionSubmitResult;
    });

    const recordRequest = Effect.fn("CirceInteraction.recordRequest")(function* (input: {
      readonly requestId: string;
      readonly interactionId: CirceInteractionId;
      readonly result: CirceInteractionSubmitResult;
    }) {
      const encoded = yield* encodeResult(input.result).pipe(
        Effect.mapError((cause) => toInteractionError("record the request", cause)),
      );
      const now = yield* DateTime.now;
      yield* sql`
        INSERT INTO circe_interaction_requests(request_id, interaction_id, result_json, created_at)
        VALUES (${input.requestId}, ${input.interactionId}, ${encoded}, ${DateTime.formatIso(now)})
        ON CONFLICT(request_id) DO UPDATE SET result_json = excluded.result_json
      `.pipe(Effect.mapError((cause) => toInteractionError("record the request", cause)));
    });

    /**
     * Durable acceptance: the operation row, the request claim and the
     * interaction revision move together. A rejected CAS rolls all three back,
     * so a lost or interrupted response can be resolved by reading the
     * operation instead of repeating the effect.
     */
    const acceptOperation = Effect.fn("CirceInteraction.acceptOperation")(function* (input: {
      readonly operation: CirceOperation;
      readonly running: CirceInteractionState;
      readonly expectedRevision: number | null;
      /** The client's submission id: the key a retry carries. */
      readonly claimRequestId: string;
      /** The mission's cancellation id, stored with the operation. */
      readonly missionRequestId: string;
      readonly result: CirceInteractionSubmitResult;
    }): Effect.fn.Return<
      { readonly status: "saved" } | { readonly status: "conflict" },
      CirceInteractionError
    > {
      const encodedOperation = yield* encodeStoredOperation({
        operation: input.operation,
        requestId: input.missionRequestId,
      }).pipe(Effect.mapError((cause) => toInteractionError("save the operation", cause)));
      const encodedState = yield* encodeState(input.running).pipe(
        Effect.mapError((cause) => toInteractionError("save the interaction", cause)),
      );
      const encodedResult = yield* encodeResult(input.result).pipe(
        Effect.mapError((cause) => toInteractionError("record the request", cause)),
      );
      const state = input.running;
      const outcome = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly revision: unknown }>`
              SELECT revision FROM circe_interactions
              WHERE interaction_id = ${state.interactionId}
                AND owner_environment_id = ${state.ownerNodeId}
            `;
            const current = rows[0];
            const matches =
              input.expectedRevision === null
                ? current === undefined
                : current !== undefined && Number(current.revision) === input.expectedRevision;
            if (!matches) return { status: "conflict" as const };
            const claimed = yield* sql<{ readonly requestId: unknown }>`
              INSERT INTO circe_interaction_requests(
                request_id, interaction_id, result_json, created_at, operation_id
              ) VALUES (
                ${input.claimRequestId}, ${state.interactionId}, ${encodedResult},
                ${DateTime.formatIso(state.updatedAt)}, ${input.operation.operationId}
              )
              ON CONFLICT(request_id) DO NOTHING
              RETURNING request_id AS requestId
            `;
            if (claimed.length === 0) return { status: "conflict" as const };
            yield* sql`
              INSERT INTO circe_operations(
                operation_id, owner_environment_id, interaction_id, status, operation_json, updated_at
              ) VALUES (
                ${input.operation.operationId}, ${input.operation.ownerNodeId},
                ${input.operation.interactionId}, ${input.operation.status}, ${encodedOperation},
                ${DateTime.formatIso(input.operation.updatedAt)}
              )
              ON CONFLICT(operation_id) DO UPDATE SET
                status = excluded.status,
                operation_json = excluded.operation_json,
                updated_at = excluded.updated_at
            `;
            yield* sql`
              INSERT INTO circe_interactions(
                interaction_id, owner_environment_id, revision, active, state_json, updated_at
              ) VALUES (
                ${state.interactionId}, ${state.ownerNodeId}, ${state.revision}, 0, ${encodedState},
                ${DateTime.formatIso(state.updatedAt)}
              )
              ON CONFLICT(interaction_id) DO UPDATE SET
                revision = excluded.revision,
                state_json = excluded.state_json,
                updated_at = excluded.updated_at
            `;
            return { status: "saved" as const };
          }),
        )
        .pipe(Effect.mapError((cause) => toInteractionError("accept the operation", cause)));
      if (outcome.status === "saved") yield* PubSub.publish(changes, input.running);
      return outcome;
    });

    const readiness = Effect.fn("CirceInteraction.readiness")(function* (): Effect.fn.Return<
      CirceDeviceReadiness,
      CirceInteractionError
    > {
      const nodeId = yield* serverEnvironment.getEnvironmentId.pipe(
        Effect.mapError((cause) => toInteractionError("read this node", cause)),
      );
      const computerStatus = yield* computerService.status.pipe(Effect.orElseSucceed(() => null));
      const controlAllowed = preset !== "headless";
      const backendReady = computerStatus !== null && computerStatus.available;
      const sessionActive = computerStatus?.host !== undefined;
      const pointerKeyboard =
        computerStatus?.host?.capabilities.pointer === true &&
        computerStatus.host.capabilities.keyboard === true;
      const permissionGranted = pointerKeyboard;
      const connectorStatus = yield* browserConnector
        .status()
        .pipe(Effect.orElseSucceed(() => ({ connected: false }) as const));
      const connectorReady = connectorStatus.connected === true;
      // A connected extension is a way to reach the browser, not permission
      // to control it: the preset decides that first.
      const browserReady = controlAllowed && (connectorReady || backendReady);
      const computerReady = controlAllowed && backendReady;
      const surface = (
        name: CirceDeviceSurfaceReadiness["surface"],
        ready: boolean,
        reason: string,
      ): CirceDeviceSurfaceReadiness => ({
        surface: name,
        ready,
        ...(ready ? {} : { reason }),
        profiles: [],
        applications: [],
      });
      const surfaces: ReadonlyArray<CirceDeviceSurfaceReadiness> = [
        surface(
          "browser",
          browserReady,
          !controlAllowed
            ? "This node has no desktop surface."
            : connectorReady
              ? ""
              : !backendReady
                ? "Connect the Circe desktop app to enable computer use, or the Chrome extension for browser missions."
                : "Desktop control is ready; connect the Chrome extension for page-level browser missions.",
        ),
        surface(
          "computer",
          computerReady,
          !controlAllowed
            ? "This node has no desktop surface."
            : !backendReady
              ? (computerStatus?.host?.reason ??
                "Connect the Circe desktop app on this node to enable computer use.")
              : "Computer use is ready.",
        ),
        surface("preview", false, "The preview host is resolved per mission."),
      ];
      return {
        nodeId,
        preset,
        controlAllowed,
        adapterSupported: backendReady,
        sessionActive,
        permissionGranted,
        surfaces,
        ...(computerStatus?.host?.reason === undefined
          ? {}
          : { detail: computerStatus.host.reason }),
      } satisfies CirceDeviceReadiness;
    });

    const interpret = Effect.fn("CirceInteraction.interpret")(function* (
      source: string,
      input: CirceInteractionSubmitInput,
      executionNodeId: EnvironmentId,
    ): Effect.fn.Return<CirceSemanticProposal, CirceInteractionError> {
      if (options.classify !== undefined) {
        return yield* options.classify(source, input, executionNodeId);
      }
      if (Option.isNone(controllerOpt)) {
        return yield* interactionError(
          "execution-unavailable",
          "This Circe node cannot interpret requests.",
        );
      }
      const controller = controllerOpt.value;
      const evidence = input.evidence;
      const shell =
        evidence === undefined
          ? yield* projectionSnapshotQuery
              .getShellSnapshot()
              .pipe(
                Effect.mapError(() =>
                  interactionError("dispatch-failed", "Circe could not read this node's projects."),
                ),
              )
          : null;
      const projects =
        evidence?.projects ??
        (shell?.projects ?? []).slice(0, MAX_PROJECTS).map((project) => ({
          title: project.title,
          names: [project.title],
        }));
      return yield* controller
        .interpret({
          utterance: source,
          projects,
          tasks: evidence?.tasks ?? [],
          providers: evidence?.providers ?? [],
          ...(evidence?.nodes === undefined ? {} : { nodes: evidence.nodes }),
          ...(evidence?.currentProjectTitle === undefined
            ? {}
            : { currentProjectTitle: evidence.currentProjectTitle }),
          ...(evidence?.focusedTask === undefined ? {} : { focusedTask: evidence.focusedTask }),
          ...(evidence?.continueContext === undefined
            ? {}
            : { continueContext: evidence.continueContext }),
          pendingHint: "none",
          ...(evidence?.clientTools === undefined ? {} : { clientTools: evidence.clientTools }),
          ...(evidence?.clientToolCandidates === undefined
            ? {}
            : { clientToolCandidates: evidence.clientToolCandidates }),
          // The client's own request identity, so `circe.cancelRequest` with
          // that id reaches this classification before it dispatches anything.
          requestMetadata: {
            requestId: input.requestId,
            ...(input.origin === undefined ? {} : { origin: input.origin }),
          },
          executionNodeId,
        })
        .pipe(
          Effect.mapError(() =>
            interactionError("dispatch-failed", "Circe could not interpret that request."),
          ),
        );
    });

    const askRelation = Effect.fn("CirceInteraction.askRelation")(function* (
      state: CirceInteractionState,
      utterance: string,
    ) {
      const outcome = yield* decision
        .decide(buildInteractionRelationRequest({ model: DECISION_MODEL, state, utterance }))
        .pipe(
          Effect.orElseSucceed(() => ({ status: "decline", reason: "decision-error" }) as const),
        );
      return outcome.status === "answered" ? readInteractionRelation(outcome.answers) : undefined;
    });

    const runLookup = Effect.fn("CirceInteraction.runLookup")(function* (
      goal: CirceLookupGoal,
      sourceUtterance: string,
    ): Effect.fn.Return<CirceLookupOutcome, CirceInteractionError> {
      // One grounding rule for every runner: the place the goal already holds
      // travels with the source, so a correction that only changes the day
      // still grounds against the user's own words.
      const source = circeLookupSourceUtterance(goal, sourceUtterance);
      if (options.lookup !== undefined) return yield* options.lookup(goal, source);
      return yield* runCirceLookup(
        {
          kind: goal.tool,
          location: goal.location ?? "",
          day: goal.day,
          sourceUtterance: source,
        },
        preset,
      ).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError((cause) => toInteractionError("run the lookup", cause)),
      );
    });

    const applyLookupOutcome = (input: {
      readonly state: CirceInteractionState;
      readonly goal: CirceLookupGoal;
      readonly outcome: CirceLookupOutcome;
      readonly now: DateTime.Utc;
    }) => {
      const { state, goal, outcome, now } = input;
      if (outcome.status === "answer") {
        return recordCirceOutcome(
          state,
          { status: "answered", message: outcome.message, source: outcome.source },
          now,
        );
      }
      if (outcome.status === "question") {
        return askCirceQuestion(
          state,
          {
            questionId: `lookup:${goal.tool}:${outcome.slot}:${outcome.reason}`,
            kind: outcome.choices.length > 0 ? "choice" : "argument",
            slot: outcome.slot,
            prompt: outcome.prompt,
            known: outcome.known,
            choices: [...outcome.choices],
          },
          now,
        );
      }
      return recordCirceOutcome(state, { status: "unavailable", message: outcome.message }, now);
    };

    /**
     * The one task this node is actually running, if any. Stop must target the
     * running task, not whichever task the asking device happens to have
     * focused.
     */
    const findRunningTask = Effect.fn("CirceInteraction.findRunningTask")(function* () {
      if (options.findRunningTask !== undefined) return yield* options.findRunningTask();
      // The V2 run projection is the live authority for provider runs. The
      // legacy shell does not carry V2 run state, so reading it here would
      // report "nothing running" while a provider turn is actually live.
      const rows = yield* sql<{
        readonly threadId: string;
        readonly projectId: string;
        readonly title: string;
      }>`
        SELECT r.thread_id AS threadId, t.project_id AS projectId, t.title AS title
        FROM orchestration_v2_projection_runs AS r
        JOIN orchestration_v2_projection_threads AS t ON t.thread_id = r.thread_id
        WHERE r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
          AND t.deleted_at IS NULL
        ORDER BY r.requested_at DESC
        LIMIT 1
      `.pipe(Effect.orElseSucceed(() => [] as const));
      const row = rows[0];
      return row === undefined
        ? null
        : {
            threadId: row.threadId as ThreadId,
            projectId: row.projectId as ProjectId,
            title: row.title,
          };
    });

    const persistConflictState = Effect.fn("CirceInteraction.persistConflictState")(function* (
      state: CirceInteractionState,
    ) {
      const current = yield* readState(state.interactionId, state.ownerNodeId);
      return current ?? state;
    });

    /**
     * Settles an operation whose physical effect is not known. It is never
     * replayed: the effect may or may not have landed.
     */
    const settleUnknown = (input: {
      readonly operation: CirceOperation;
      readonly running: CirceInteractionState;
      readonly requestId: string;
      readonly detail: string;
    }) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* saveOperation({
          operation: {
            ...input.operation,
            status: "outcome-unknown",
            lastResult: "unknown",
            verification: { checked: false, detail: input.detail },
            updatedAt: now,
          },
          requestId: input.requestId,
        });
        yield* saveState({
          state: recordCirceOutcome(
            input.running,
            {
              status: "outcome-unknown",
              message:
                "That operation stopped before it reported back, so its result is unknown. Check the target before asking again.",
            },
            now,
          ),
          expectedRevision: input.running.revision,
          makeActive: false,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Circe could not settle an interrupted operation", { cause }),
        ),
      );

    const dispatchDevice = Effect.fn("CirceInteraction.dispatchDevice")(function* (input: {
      readonly state: CirceInteractionState;
      readonly surface: "browser" | "preview" | "computer";
      readonly goal: string;
      readonly submit: CirceInteractionSubmitInput;
      readonly executionNodeId: EnvironmentId;
      readonly now: DateTime.Utc;
      /**
       * The revision the acceptance transaction compares against. It is the
       * revision currently in storage, which differs from the new state's
       * revision when an approval was just consumed.
       */
      readonly expectedRevision: number | null;
    }): Effect.fn.Return<CirceInteractionSubmitResult, CirceInteractionError> {
      const { state, surface, goal, submit, executionNodeId, now, expectedRevision } = input;
      const connectorStatus =
        surface === "browser"
          ? yield* browserConnector
              .status()
              .pipe(Effect.orElseSucceed(() => ({ connected: false }) as const))
          : null;
      const useConnector =
        preset !== "headless" && surface === "browser" && connectorStatus?.connected === true;
      if (surface !== "preview" && !useConnector) {
        const readinessState = yield* readiness();
        const surfaceReadiness = readinessState.surfaces.find(
          (candidate) => candidate.surface === surface,
        );
        if (surfaceReadiness?.ready !== true) {
          const unavailable = recordCirceOutcome(
            state,
            {
              status: "unavailable",
              message:
                surfaceReadiness?.reason ?? "Desktop control is not ready on this node right now.",
            },
            now,
          );
          const saved = yield* saveState({
            state: unavailable,
            expectedRevision,
            makeActive: false,
          });
          const finalState =
            saved.status === "conflict" ? yield* persistConflictState(unavailable) : unavailable;
          return {
            status: "unavailable",
            state: finalState,
            message: finalState.outcome?.message ?? "Desktop control is not ready.",
          };
        }
      }

      const target = {
        nodeId: executionNodeId,
        surface,
        ...(submit.preferredProfile === undefined ? {} : { profile: submit.preferredProfile }),
      };
      const withTarget = bindCirceDeviceTarget(state, target, now);
      const operationId = yield* newOperationId;
      const requestId = `${submit.requestId}:${operationId}`;
      const operation: CirceOperation = {
        operationId,
        ownerNodeId: executionNodeId,
        interactionId: withTarget.interactionId,
        interactionRevision: withTarget.revision,
        target,
        authorizedScope: ["observe", "input", "navigate", "launch"],
        goal,
        expectedOutcome: goal,
        status: "accepted",
        steps: 0,
        lastResult: null,
        verification: null,
        createdAt: now,
        updatedAt: now,
      };
      const running: CirceInteractionState = { ...withTarget, operationId, outcome: null };
      /** Saves the result the mission reported, and the interaction's outcome with it. */
      const persistResult = (result: CirceBrowserUseResult) =>
        Effect.gen(function* () {
          const mapped = missionStatus(result.status);
          const settledAt = yield* DateTime.now;
          const settledOperation: CirceOperation = {
            ...operation,
            status: mapped.status,
            steps: "steps" in result && typeof result.steps === "number" ? result.steps : 0,
            lastResult: mapped.result,
            verification: {
              checked: mapped.status === "completed",
              detail: result.message.slice(0, 400),
            },
            updatedAt: settledAt,
          };
          yield* saveOperation({ operation: settledOperation, requestId });
          const settled = recordCirceOutcome(
            running,
            { status: outcomeStatusForMission(mapped.status), message: result.message },
            settledAt,
          );
          const savedSettled = yield* saveState({
            state: settled,
            expectedRevision: running.revision,
            makeActive: false,
          });
          // A conflicting write means someone else (a stop, another device)
          // already moved the interaction. Return that persisted state instead of
          // the locally computed one, so the reply never reports a state the
          // database does not hold.
          const finalState =
            savedSettled.status === "conflict" ? yield* persistConflictState(settled) : settled;
          const settledResult: CirceInteractionSubmitResult = {
            status: "operation",
            state: finalState,
            operation: settledOperation,
          };
          return settledResult;
        });

      // A result the mission reported survives a failure to save it: the
      // exit handler saves it again instead of calling it unknown. Only an
      // exit before any result is recorded as unknown, and it is never
      // replayed.
      let observed: CirceBrowserUseResult | null = null;
      const execute = Effect.gen(function* () {
        const missionInput = {
          goal,
          confirmed: true as const,
          requestMetadata: {
            requestId,
            ...(submit.origin === undefined ? {} : { origin: submit.origin }),
          },
          // The accepted target is the only target: the adapter must not fall
          // back to an attached connector, profile, or window it discovers
          // later. A mission without it is refused by the adapter.
          target,
        };
        // Browser means the user's real browser: the connector drives the
        // signed-in profile, and desktop control is the fallback when no
        // extension is attached. The preview broker is only ever the preview
        // surface, which is an explicit different choice.
        const result =
          surface === "preview"
            ? yield* browserUse.run(missionInput)
            : surface === "browser" && useConnector
              ? yield* browserConnectorUse.run(missionInput)
              : yield* computerAccess.run({
                  goal,
                  cancelId: requestId,
                  target,
                });
        observed = result;
        return yield* persistResult(result);
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : observed !== null
              ? persistResult(observed).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Circe could not save an operation's result", { cause }),
                  ),
                )
              : settleUnknown({
                  operation,
                  running,
                  requestId,
                  detail: "Circe stopped before this operation reported an outcome.",
                }),
        ),
      );

      // Acceptance is durable before the first physical action, and it claims
      // the client's request id in the same transaction: a retry during the
      // mission returns this operation instead of accepting a second one.
      // Acceptance and handing the operation to the node happen together, so
      // an interrupted requester never leaves an accepted operation without
      // the worker that settles it.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const accepted = yield* acceptOperation({
            operation,
            running,
            expectedRevision,
            claimRequestId: submit.requestId,
            missionRequestId: requestId,
            result: { status: "operation", state: running, operation },
          });
          if (accepted.status === "conflict") {
            const stale: CirceInteractionSubmitResult = {
              status: "stale",
              state: yield* persistConflictState(running),
            };
            return stale;
          }
          const execution = yield* execute.pipe(Effect.forkIn(operationScope));
          return yield* restore(Fiber.join(execution));
        }),
      );
    });

    const classifyNew = Effect.fn("CirceInteraction.classifyNew")(function* (input: {
      readonly submit: CirceInteractionSubmitInput;
      readonly executionNodeId: EnvironmentId;
      readonly now: DateTime.Utc;
      readonly existing?: CirceInteractionState;
    }): Effect.fn.Return<CirceInteractionSubmitResult, CirceInteractionError> {
      const { submit, executionNodeId, now } = input;
      const source = submit.utterance;
      const proposal = yield* interpret(source, submit, executionNodeId);
      const direct = directGoalFromProposal(proposal);
      // A classification that replaces an existing goal is a transition, so it
      // advances the revision; a brand-new interaction starts at zero.
      const revision = input.existing === undefined ? 0 : input.existing.revision + 1;
      const interactionId = input.existing?.interactionId ?? (yield* newInteractionId);
      const expectedRevision = input.existing?.revision ?? null;

      if (direct?.kind === "lookup") {
        const created = createLookupInteraction({
          interactionId,
          ownerNodeId: executionNodeId,
          tool: direct.tool,
          day: direct.day,
          ...(direct.location === undefined ? {} : { location: direct.location }),
          now,
        });
        const state: CirceInteractionState = { ...created.state, revision };
        const saved = yield* saveState({
          state,
          expectedRevision,
          makeActive: input.existing === undefined,
        });
        if (saved.status === "conflict") {
          return {
            status: "failed",
            state,
            message: "Circe could not start that interaction.",
          };
        }
        if (state.goal.kind !== "lookup") {
          return { status: "failed", state, message: "Circe lost the lookup goal." };
        }
        if (direct.location === undefined) {
          const question: CirceInteractionSubmitResult = { status: "question", state };
          yield* recordRequest({
            requestId: submit.requestId,
            interactionId: state.interactionId,
            result: question,
          });
          return question;
        }
        const lookup = yield* runLookup(state.goal, source);
        const next = applyLookupOutcome({ state, goal: state.goal, outcome: lookup, now });
        yield* saveState({ state: next, expectedRevision: state.revision, makeActive: false });
        const result: CirceInteractionSubmitResult =
          next.outcome?.status === "answered"
            ? {
                status: "answered",
                state: next,
                message: next.outcome.message,
                ...(next.outcome.source === undefined ? {} : { source: next.outcome.source }),
              }
            : { status: "question", state: next };
        yield* recordRequest({
          requestId: submit.requestId,
          interactionId: next.interactionId,
          result,
        });
        return result;
      }

      if (direct?.kind === "device") {
        const state: CirceInteractionState = {
          ...emptyInteractionState({
            interactionId,
            ownerNodeId: executionNodeId,
            revision,
            goal: { kind: "device", surface: direct.surface, goal: direct.goal },
            now,
          }),
          pending: direct.requiresApproval
            ? deviceApprovalQuestion(direct.surface, direct.goal)
            : null,
        };
        const saved = yield* saveState({
          state,
          expectedRevision,
          makeActive: input.existing === undefined,
        });
        if (saved.status === "conflict") {
          return {
            status: "failed",
            state,
            message: "Circe could not start that interaction.",
          };
        }
        if (direct.requiresApproval) {
          const question: CirceInteractionSubmitResult = { status: "question", state };
          yield* recordRequest({
            requestId: submit.requestId,
            interactionId: state.interactionId,
            result: question,
          });
          return question;
        }
        const result = yield* dispatchDevice({
          state,
          surface: direct.surface,
          goal: direct.goal,
          submit,
          executionNodeId,
          now,
          expectedRevision: state.revision,
        });
        yield* recordRequest({
          requestId: submit.requestId,
          interactionId: state.interactionId,
          result,
        });
        return result;
      }

      // Coding and conversation stay with the ordinary provider path. The
      // interaction records the goal so a follow-up is owned, and the client
      // executes the grounded proposal it receives.
      const goal: CirceInteractionGoal =
        proposal.action === "converse" ? { kind: "conversation" } : { kind: "coding" };
      const state = emptyInteractionState({
        interactionId,
        ownerNodeId: executionNodeId,
        revision,
        goal,
        now,
      });
      const saved = yield* saveState({
        state,
        expectedRevision,
        makeActive: input.existing === undefined,
      });
      if (saved.status === "conflict") {
        return { status: "failed", state, message: "Circe could not start that interaction." };
      }
      const delegated: CirceInteractionSubmitResult = { status: "delegated", state, proposal };
      yield* recordRequest({
        requestId: submit.requestId,
        interactionId: state.interactionId,
        result: delegated,
      });
      return delegated;
    });

    /**
     * Stop the task this node is actually running. The node owns the shell
     * projection, so it resolves the running task and interrupts it here
     * instead of asking the client to guess from its focused task. A node
     * without the controller service delegates the stop proposal instead.
     */
    const stopWork = Effect.fn("CirceInteraction.stopWork")(function* (request: {
      readonly state: CirceInteractionState;
      readonly input: CirceInteractionSubmitInput & {
        readonly executionNodeId: EnvironmentId;
        readonly sessionId?: AuthSessionId;
      };
      readonly now: DateTime.Utc;
    }): Effect.fn.Return<CirceInteractionSubmitResult, CirceInteractionError> {
      const { state, input, now } = request;
      // An interaction that owns a device operation stops that exact
      // operation. Only a coding or conversation goal falls through to the
      // node's running provider task.
      if (state.operationId !== null) {
        const stored = yield* readOperation(state.operationId);
        if (stored !== null) {
          const requested = yield* missionCancellation.requestStop(stored.requestId);
          const settled = requested
            ? yield* missionCancellation.awaitSettled(stored.requestId)
            : !(yield* missionCancellation.isActive(stored.requestId));
          const message = settled
            ? "Stopped."
            : "Stop requested; the mission has not confirmed that it stopped yet.";
          const next = recordCirceOutcome(state, { status: "stopped", message }, now);
          yield* saveState({ state: next, expectedRevision: state.revision, makeActive: false });
          return { status: "cancelled", state: next };
        }
      }
      const running = yield* findRunningTask();
      if (running === null) {
        const next = recordCirceOutcome(
          state,
          {
            status: "stopped",
            // A pending question is the thing being dismissed; with nothing
            // pending and nothing running, say so plainly.
            message: state.pending === null ? "Nothing is running on this node." : "Stopped.",
          },
          now,
        );
        yield* saveState({ state: next, expectedRevision: state.revision, makeActive: false });
        return { status: "cancelled", state: next };
      }
      if (controller === undefined || input.sessionId === undefined) {
        return {
          status: "delegated",
          state,
          proposal: { action: "stop", refs: [], model: null, effort: null, answer: null },
        };
      }
      const execution = yield* controller
        .execute({
          sessionId: input.sessionId,
          utterance: input.utterance,
          projectId: running.projectId,
          contextThreadId: running.threadId,
          referenceThreadId: running.threadId,
          semanticProposal: { action: "stop", refs: [], model: null, effort: null, answer: null },
          requestMetadata: {
            requestId: input.requestId,
            ...(input.origin === undefined ? {} : { origin: input.origin }),
          },
          executionNodeId: input.executionNodeId,
        })
        .pipe(
          Effect.catch(() =>
            Effect.succeed({
              status: "acknowledged" as const,
              action: "interrupted" as const,
              threadId: running.threadId,
              projectId: running.projectId,
              message: `${running.title} is stopping.`,
            }),
          ),
        );
      const message = execution.status === "acknowledged" ? execution.message : "Stop requested.";
      const next = recordCirceOutcome(state, { status: "stopped", message }, now);
      yield* saveState({ state: next, expectedRevision: state.revision, makeActive: false });
      return { status: "cancelled", state: next };
    });

    const submit = Effect.fn("CirceInteraction.submit")(function* (
      input: CirceInteractionSubmitInput & {
        readonly executionNodeId: EnvironmentId;
        readonly sessionId?: AuthSessionId;
      },
    ): Effect.fn.Return<CirceInteractionSubmitResult, CirceInteractionError> {
      yield* reconcileOnce;
      const cached = yield* findRequest(input.requestId);
      if (cached !== null) return cached;

      const state =
        input.interactionId === undefined
          ? yield* readActive(input.executionNodeId)
          : yield* readState(input.interactionId, input.executionNodeId);
      if (input.interactionId !== undefined && state === null) {
        return yield* interactionError(
          "not-found",
          "That Circe interaction is no longer available.",
        );
      }
      if (state !== null && state.ownerNodeId !== input.executionNodeId) {
        return yield* interactionError(
          "node-mismatch",
          "That interaction belongs to a different Circe node.",
        );
      }
      if (
        state !== null &&
        input.expectedRevision !== undefined &&
        state.revision !== input.expectedRevision
      ) {
        return { status: "stale", state };
      }

      const now = yield* DateTime.now;
      if (input.preferredNodeId !== undefined && input.preferredNodeId !== input.executionNodeId) {
        if (state === null) {
          return yield* interactionError(
            "node-mismatch",
            "That request names a different Circe node.",
          );
        }
        const next = recordCirceOutcome(
          state,
          {
            status: "unavailable",
            message: "That request names a different Circe node, so this node did not run it.",
          },
          now,
        );
        yield* saveState({ state: next, expectedRevision: state.revision, makeActive: false });
        return { status: "unavailable", state: next, message: next.outcome?.message ?? "" };
      }

      if (state === null) {
        return yield* classifyNew({ submit: input, executionNodeId: input.executionNodeId, now });
      }

      const projectNames = input.evidence?.projects.map((project) => project.title) ?? [];
      // A question-shaped input against a pending slot is uncertain: when the
      // model gives no verdict, it is new work, never a guessed answer.
      const uncertain = state.pending !== null && needsRelationDecision(state, input.utterance);
      const proposedRelation = uncertain
        ? ((yield* askRelation(state, input.utterance)) ?? ("new-request" as const))
        : undefined;
      const decisionResult = decideCirceInteractionInput({
        state,
        utterance: input.utterance,
        now,
        projectNames,
        ...(proposedRelation === undefined ? {} : { proposedRelation }),
      });

      if (
        decisionResult.problem === "answer-had-no-slot" ||
        decisionResult.problem === "answer-was-ambiguous"
      ) {
        if (decisionResult.state !== state) {
          yield* saveState({
            state: decisionResult.state,
            expectedRevision: state.revision,
            makeActive: false,
          });
        }
        const question: CirceInteractionSubmitResult = {
          status: "question",
          state: decisionResult.state,
        };
        yield* recordRequest({
          requestId: input.requestId,
          interactionId: decisionResult.state.interactionId,
          result: question,
        });
        return question;
      }

      switch (decisionResult.effect.kind) {
        case "none": {
          const saved = yield* saveState({
            state: decisionResult.state,
            expectedRevision: state.revision,
            makeActive: false,
          });
          if (saved.status === "conflict") {
            return { status: "stale", state: yield* persistConflictState(decisionResult.state) };
          }
          const result: CirceInteractionSubmitResult =
            decisionResult.state.outcome?.status === "stopped"
              ? { status: "cancelled", state: decisionResult.state }
              : { status: "question", state: decisionResult.state };
          yield* recordRequest({
            requestId: input.requestId,
            interactionId: decisionResult.state.interactionId,
            result,
          });
          return result;
        }
        case "run-lookup": {
          const saved = yield* saveState({
            state: decisionResult.state,
            expectedRevision: state.revision,
            makeActive: false,
          });
          if (saved.status === "conflict") {
            return { status: "stale", state: yield* persistConflictState(decisionResult.state) };
          }
          const goal = decisionResult.state.goal;
          if (goal.kind !== "lookup") {
            return {
              status: "failed",
              state: decisionResult.state,
              message: "Circe lost the lookup goal.",
            };
          }
          const lookup = yield* runLookup(goal, input.utterance);
          const next = applyLookupOutcome({
            state: decisionResult.state,
            goal,
            outcome: lookup,
            now,
          });
          yield* saveState({
            state: next,
            expectedRevision: decisionResult.state.revision,
            makeActive: false,
          });
          const result: CirceInteractionSubmitResult =
            next.outcome?.status === "answered"
              ? {
                  status: "answered",
                  state: next,
                  message: next.outcome.message,
                  ...(next.outcome.source === undefined ? {} : { source: next.outcome.source }),
                }
              : { status: "question", state: next };
          yield* recordRequest({
            requestId: input.requestId,
            interactionId: next.interactionId,
            result,
          });
          return result;
        }
        case "start-device": {
          const result = yield* dispatchDevice({
            state: decisionResult.state,
            surface: decisionResult.effect.surface,
            goal: decisionResult.effect.goal,
            submit: input,
            executionNodeId: input.executionNodeId,
            now,
            expectedRevision: state.revision,
          });
          yield* recordRequest({
            requestId: input.requestId,
            interactionId: decisionResult.state.interactionId,
            result,
          });
          return result;
        }
        case "stop-work": {
          const result = yield* stopWork({
            state: decisionResult.state,
            input,
            now,
          });
          yield* recordRequest({
            requestId: input.requestId,
            interactionId: decisionResult.state.interactionId,
            result,
          });
          return result;
        }
        case "classify": {
          if (decisionResult.state !== state) {
            yield* saveState({
              state: decisionResult.state,
              expectedRevision: state.revision,
              makeActive: false,
            });
          }
          return yield* classifyNew({
            submit: input,
            executionNodeId: input.executionNodeId,
            now,
            existing: decisionResult.state,
          });
        }
      }
    });

    /**
     * Startup reconciliation. An operation that was accepted but never
     * settled by this process is marked unknown; it is never replayed,
     * because its effect may or may not have landed.
     */
    const reconcile = Effect.fn("CirceInteraction.reconcile")(function* () {
      const nodeId = yield* serverEnvironment.getEnvironmentId.pipe(
        Effect.mapError((cause) => toInteractionError("read this node", cause)),
      );
      const rows = yield* sql<{ readonly operationJson: unknown }>`
        SELECT operation_json AS operationJson FROM circe_operations
        WHERE owner_environment_id = ${nodeId}
          AND status IN ('accepted', 'running', 'verifying')
      `.pipe(Effect.mapError((cause) => toInteractionError("load unsettled operations", cause)));
      if (rows.length === 0) return;
      const now = yield* DateTime.now;
      for (const row of rows) {
        const stored = yield* decodeStoredOperation(row.operationJson).pipe(
          Effect.mapError((cause) => toInteractionError("read an unsettled operation", cause)),
        );
        const settled: CirceOperation = {
          ...stored.operation,
          status: "outcome-unknown",
          lastResult: "unknown",
          verification: {
            checked: false,
            detail: "The node restarted before this operation reported an outcome.",
          },
          updatedAt: now,
        };
        yield* saveOperation({ operation: settled, requestId: stored.requestId });
        const state = yield* readState(settled.interactionId, settled.ownerNodeId);
        if (state !== null && state.operationId === settled.operationId && state.outcome === null) {
          const next = recordCirceOutcome(
            state,
            {
              status: "outcome-unknown",
              message:
                "The node restarted while that operation was running, so its result is unknown. Check the target before asking again.",
            },
            now,
          );
          yield* saveState({ state: next, expectedRevision: state.revision, makeActive: false });
        }
      }
    });
    // Reconciliation runs until it succeeds once. A failure is not cached, so
    // a transient storage error does not refuse every later call, and the
    // lock keeps a second reconciliation from marking an operation accepted
    // after the first one as unknown.
    const reconcileLock = yield* Semaphore.make(1);
    let reconciled = false;
    const reconcileOnce = reconcileLock.withPermits(1)(
      Effect.suspend(() =>
        reconciled
          ? Effect.void
          : reconcile().pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  reconciled = true;
                }),
              ),
            ),
      ),
    );

    const read = Effect.fn("CirceInteraction.read")(function* (input: {
      readonly executionNodeId: EnvironmentId;
      readonly interactionId?: CirceInteractionId;
    }): Effect.fn.Return<CirceInteractionState | null, CirceInteractionError> {
      yield* reconcileOnce;
      if (input.interactionId !== undefined) {
        return yield* readState(input.interactionId, input.executionNodeId);
      }
      return yield* readActive(input.executionNodeId);
    });

    const interrupt = Effect.fn("CirceInteraction.interrupt")(function* (
      input: CirceInteractionInterruptInput & { readonly executionNodeId: EnvironmentId },
    ): Effect.fn.Return<CirceInteractionInterruptResult, CirceInteractionError> {
      yield* reconcileOnce;
      const state = yield* readState(input.interactionId, input.executionNodeId);
      if (state === null) {
        return yield* interactionError(
          "not-found",
          "That Circe interaction is no longer available.",
        );
      }
      if (state.ownerNodeId !== input.executionNodeId) {
        return yield* interactionError(
          "node-mismatch",
          "That interaction belongs to a different Circe node.",
        );
      }
      if (state.operationId !== null) {
        const stored = yield* readOperation(state.operationId);
        if (stored !== null) {
          const requested = yield* missionCancellation.requestStop(stored.requestId);
          // Asking is not stopping: confirmation follows the executor's own
          // cleanup, so `stopConfirmed` is never a previously-set flag.
          const settled = requested
            ? yield* missionCancellation.awaitSettled(stored.requestId)
            : !(yield* missionCancellation.isActive(stored.requestId));
          const current = (yield* readState(input.interactionId, input.executionNodeId)) ?? state;
          return {
            stopRequested: requested || settled,
            stopConfirmed: settled,
            state: current,
          } satisfies CirceInteractionInterruptResult;
        }
      }
      if (state.pending !== null) {
        const now = yield* DateTime.now;
        const next = recordCirceOutcome(state, { status: "stopped", message: "Stopped." }, now);
        yield* saveState({ state: next, expectedRevision: state.revision, makeActive: false });
        return {
          stopRequested: true,
          stopConfirmed: true,
          state: next,
        } satisfies CirceInteractionInterruptResult;
      }
      return { stopRequested: false, stopConfirmed: false, state };
    });

    const subscribe = (input: { readonly interactionId?: CirceInteractionId | undefined }) =>
      Stream.fromPubSub(changes).pipe(
        Stream.filter(
          (state) =>
            input.interactionId === undefined || state.interactionId === input.interactionId,
        ),
      );

    return CirceInteraction.of({ submit, read, interrupt, subscribe, readiness });
  });

export const CirceInteractionLive = Layer.effect(CirceInteraction, make());
