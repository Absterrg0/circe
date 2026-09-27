import { normalizeDestinationPhrase, stripDestinationQuotes } from "@circe/core/destinationSpan";
import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  isProviderAvailable,
  type CirceCancelMissionInput,
  type CirceCancelMissionResult,
  type CirceCancelRequestInput,
  type CirceCancelRequestResult,
  type CirceComputerStatus,
  type CirceComputerUseInput,
  type CirceComputerUseResult,
  type CirceExecuteInput,
  type CirceExecutionResult,
  type CirceInterpretInput,
  type CirceInterpretResult,
  type CirceInteractionId,
  type CirceInteractionInterruptInput,
  type CirceInteractionInterruptResult,
  type CirceInteractionReadResult,
  type CirceInteractionSubmitInput,
  type CirceInteractionSubmitResult,
  type CirceDeviceReadiness,
  type CirceManageProjectAliasResult,
  type CirceNodeCapabilities,
  type CirceProjectRef,
  type CirceProjectVocabularyEntry,
  type CirceRequestMetadata,
  type CirceFocusTaskInput,
  type CirceFocusTaskResult,
  type CirceTaskDeskView,
  type ServerProvider,
  WS_METHODS,
} from "@circe/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  type ConnectionCatalogEntry,
  ConnectionBlockedError,
  ConnectionTransientError,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  type SupervisorConnectionPhase,
} from "@circe/client/connection";
import {
  executeCirceInstruction,
  interpretCirceInstruction,
  cancelCirceMission,
  cancelCirceRequest,
  getCirceComputerStatus,
  getCirceDeviceReadiness,
  getCirceProjectVocabulary,
  getCirceTaskDesk,
  interruptCirceInteraction,
  manageCirceProjectAlias,
  readCirceInteraction,
  submitCirceInteraction,
  useCirceComputer,
  focusCirceTask,
} from "../operations/circe.ts";
import {
  EnvironmentRpcUnavailableError,
  isRpcClientError,
  request,
  type EnvironmentRpcFailure,
} from "@circe/client/rpc";

export type CirceMeshReachability = "online" | "offline";
export const CIRCE_MESH_REFRESH_CONCURRENCY = 4;
export type CirceMeshCatalogErrorKind =
  | "unreachable"
  | "authentication"
  | "incompatible"
  | "service";

export interface CirceMeshNode {
  readonly nodeId: EnvironmentId;
  readonly label: string;
  readonly reachability: CirceMeshReachability;
  /** Canonical execution and surface capabilities advertised by the node. */
  readonly capabilities?: CirceNodeCapabilities;
  /**
   * Whether the node's own configured semantic supervisor instance is
   * currently available for project-free conversation. Computed from the
   * node's advertised settings plus its provider snapshot: the node itself
   * is the authority for which instance it would use. False only when a
   * successful configuration read confirms the configured supervisor is
   * unavailable. Absent when readiness is unknown — no connection, failed
   * probe, incompatible descriptor, or settings without a supervisor
   * selection — so callers fall back instead of refusing.
   */
  readonly conversationReady?: boolean | undefined;
  /** A connected node can still have an unavailable Circe catalog. */
  readonly catalogError?: string;
  /** A registered node has not finished its current catalog read. */
  readonly catalogPending?: boolean;
  /** Stable classification for rendering a useful recovery action. */
  readonly catalogErrorKind?: CirceMeshCatalogErrorKind;
}

export type CirceMeshProject = CirceProjectVocabularyEntry & {
  readonly ref: CirceProjectRef;
  readonly nodeLabel: string;
};

export interface CirceMeshProvider {
  readonly nodeId: EnvironmentId;
  readonly nodeLabel: string;
  readonly snapshot: ServerProvider;
  /** Informational readiness only; the target server validates execution. */
  readonly available: boolean;
}

export interface CirceMeshCatalog {
  readonly nodes: ReadonlyArray<CirceMeshNode>;
  readonly projects: ReadonlyArray<CirceMeshProject>;
  readonly providers: ReadonlyArray<CirceMeshProvider>;
}

export type CirceMeshProjectCandidate = CirceMeshProject & {
  readonly label: string;
};

export type CirceMeshProjectResolution =
  | {
      readonly status: "resolved";
      readonly project: CirceMeshProject;
    }
  | {
      readonly status: "needs-clarification";
      readonly candidates: ReadonlyArray<CirceMeshProjectCandidate>;
    }
  | {
      readonly status: "not-found";
    };

export class CirceMeshNodeUnavailableError extends Schema.TaggedError<CirceMeshNodeUnavailableError>()(
  "CirceMeshNodeUnavailableError",
  {
    nodeId: EnvironmentId,
    label: Schema.String,
    phase: Schema.Literals(["available", "offline", "connecting", "backoff", "blocked"]),
  },
) {
  override get message(): string {
    return `${this.label} is not connected (state: ${this.phase}).`;
  }
}

export class CirceMeshConversationUnavailableError extends Schema.TaggedError<CirceMeshConversationUnavailableError>()(
  "CirceMeshConversationUnavailableError",
  {
    nodeId: EnvironmentId,
    label: Schema.String,
  },
) {
  override get message(): string {
    return `${this.label} cannot run Circe conversation: its semantic supervisor is unavailable.`;
  }
}

export type CirceMeshExecuteInput = Omit<
  Extract<CirceExecuteInput, { kind: "control" }>,
  "projectId" | "requestMetadata"
> & {
  readonly projectRef: CirceProjectRef;
  readonly requestMetadata: CirceRequestMetadata;
};

export type CirceMeshConverseInput = {
  readonly nodeId: EnvironmentId;
  readonly utterance: Extract<CirceExecuteInput, { kind: "converse" }>["utterance"];
  readonly requestMetadata?: Extract<CirceExecuteInput, { kind: "converse" }>["requestMetadata"];
};

export type CirceMeshFocusTaskInput = {
  readonly nodeId: EnvironmentId;
  readonly task: CirceFocusTaskInput;
};

export type CirceMeshManageProjectAliasInput =
  | {
      readonly projectRef: CirceProjectRef;
      readonly action: "set";
      readonly alias: string;
      readonly kind: "confirmed-pronunciation" | "user-defined";
    }
  | {
      readonly projectRef: CirceProjectRef;
      readonly action: "remove";
      readonly alias: string;
    };

type CirceMeshOperationError<T> = T extends Effect.Effect<infer _A, infer E, infer _R> ? E : never;

export type CirceMeshInterpretInput = {
  readonly nodeId: EnvironmentId;
  readonly interpret: CirceInterpretInput;
};

type ExecuteError = CirceMeshOperationError<ReturnType<typeof executeCirceInstruction>>;
type InterpretError = CirceMeshOperationError<
  ReturnType<typeof import("../operations/circe.ts").interpretCirceInstruction>
>;
type TaskDeskError = CirceMeshOperationError<ReturnType<typeof getCirceTaskDesk>>;
type InteractionSubmitError = CirceMeshOperationError<ReturnType<typeof submitCirceInteraction>>;
type InteractionReadError = CirceMeshOperationError<ReturnType<typeof readCirceInteraction>>;
type InteractionInterruptError = CirceMeshOperationError<
  ReturnType<typeof interruptCirceInteraction>
>;
type DeviceReadinessError = CirceMeshOperationError<ReturnType<typeof getCirceDeviceReadiness>>;
type ComputerStatusError = CirceMeshOperationError<ReturnType<typeof getCirceComputerStatus>>;
type ComputerMissionError = CirceMeshOperationError<ReturnType<typeof useCirceComputer>>;
type CancelMissionError = CirceMeshOperationError<ReturnType<typeof cancelCirceMission>>;
type FocusTaskError = CirceMeshOperationError<ReturnType<typeof focusCirceTask>>;
type AliasError = CirceMeshOperationError<ReturnType<typeof manageCirceProjectAlias>>;
type NodeError = EnvironmentNotRegisteredError | CirceMeshNodeUnavailableError;
type CatalogError =
  | NodeError
  | CirceMeshOperationError<ReturnType<typeof getCirceProjectVocabulary>>
  | EnvironmentRpcFailure<typeof WS_METHODS.serverGetConfig>;

export interface CirceMeshService {
  readonly catalogChanges: Stream.Stream<CirceMeshCatalog>;
  readonly refresh: Effect.Effect<CirceMeshCatalog, CatalogError>;
  /**
   * Refresh one node and merge it into the shared catalog without waiting
   * for unrelated nodes. Use this to validate an already-selected execution
   * node instead of stalling a submission on a slow peer.
   */
  readonly refreshNode: (nodeId: EnvironmentId) => Effect.Effect<CirceMeshCatalog, CatalogError>;
  readonly resolveProject: (query: string) => Effect.Effect<CirceMeshProjectResolution>;
  /**
   * One configured-supervisor inference before irreversible routing. Runs on
   * the selected semantic node (ambient online preferred, else first online)
   * over verbatim source plus untrusted mesh evidence. Returns a typed
   * proposal with no dispatch; the client grounds it and the execution node
   * revalidates. Uses ordinary authenticated clients and the node's ordinary
   * provider registry, never a direct provider.
   */
  readonly interpret: (
    input: CirceMeshInterpretInput,
  ) => Effect.Effect<CirceInterpretResult, NodeError | InterpretError>;
  readonly execute: (
    input: CirceMeshExecuteInput,
  ) => Effect.Effect<CirceExecutionResult, NodeError | ExecuteError>;
  /**
   * Cancel one pre-accept request on its explicit node. The result is
   * cancelled, already-accepted with the running identity, or unknown when
   * nothing cancellable is known; callers keep waiting on unknown.
   */
  readonly cancelRequest: (
    nodeId: EnvironmentId,
    input: CirceCancelRequestInput,
  ) => Effect.Effect<CirceCancelRequestResult, NodeError | ExecuteError>;
  /**
   * Project-free conversation on one online node. Answers are best-effort
   * and not receipt-backed: retries ask again.
   */
  readonly converse: (
    input: CirceMeshConverseInput,
  ) => Effect.Effect<
    CirceExecutionResult,
    NodeError | CirceMeshConversationUnavailableError | ExecuteError
  >;
  readonly getTaskDesk: (
    nodeId: EnvironmentId,
  ) => Effect.Effect<CirceTaskDeskView, NodeError | TaskDeskError>;
  /**
   * Submit one utterance to the node-owned interaction. The node resolves the
   * relation to its active goal, owns any pending question, and returns state
   * or a grounded proposal for ordinary work.
   */
  readonly submitInteraction: (input: {
    readonly nodeId: EnvironmentId;
    readonly input: CirceInteractionSubmitInput;
  }) => Effect.Effect<CirceInteractionSubmitResult, NodeError | InteractionSubmitError>;
  readonly readInteraction: (input: {
    readonly nodeId: EnvironmentId;
    readonly interactionId?: CirceInteractionId | undefined;
  }) => Effect.Effect<CirceInteractionReadResult, NodeError | InteractionReadError>;
  readonly interruptInteraction: (input: {
    readonly nodeId: EnvironmentId;
    readonly input: CirceInteractionInterruptInput;
  }) => Effect.Effect<CirceInteractionInterruptResult, NodeError | InteractionInterruptError>;
  /** Observed desktop readiness; clients act only on ready surfaces. */
  readonly deviceReadiness: (
    nodeId: EnvironmentId,
  ) => Effect.Effect<CirceDeviceReadiness, NodeError | DeviceReadinessError>;
  /** Live desktop-host status and the node's active computer mission. */
  readonly computerStatus: (
    nodeId: EnvironmentId,
  ) => Effect.Effect<CirceComputerStatus, NodeError | ComputerStatusError>;
  /** Run one bounded computer mission on an explicit node. */
  readonly computerUse: (input: {
    readonly nodeId: EnvironmentId;
    readonly input: CirceComputerUseInput;
  }) => Effect.Effect<CirceComputerUseResult, NodeError | ComputerMissionError>;
  /** Stop one running mission by the request id it registered under. */
  readonly cancelMission: (input: {
    readonly nodeId: EnvironmentId;
    readonly input: CirceCancelMissionInput;
  }) => Effect.Effect<CirceCancelMissionResult, NodeError | CancelMissionError>;
  readonly focusTask: (
    input: CirceMeshFocusTaskInput,
  ) => Effect.Effect<CirceFocusTaskResult, NodeError | FocusTaskError>;
  readonly manageProjectAlias: (
    input: CirceMeshManageProjectAliasInput,
  ) => Effect.Effect<CirceManageProjectAliasResult, NodeError | AliasError>;
}

export class CirceMesh extends Context.Service<CirceMesh, CirceMeshService>()(
  "@circe/client-runtime/circe/mesh/CirceMesh",
) {}

const EMPTY_CATALOG: CirceMeshCatalog = {
  nodes: [],
  projects: [],
  providers: [],
};

const normalize = (value: string): string => value.trim().toLowerCase();

const projectKey = (project: CirceMeshProject): string =>
  `${project.ref.nodeId}:${project.ref.projectId}`;

const projectLabel = (project: CirceMeshProject): string =>
  `${project.title} — ${project.nodeLabel}`;

const uniqueProjects = (
  projects: ReadonlyArray<CirceMeshProject>,
): ReadonlyArray<CirceMeshProject> => {
  const seen = new Set<string>();
  return projects.filter((project) => {
    const key = projectKey(project);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const projectExactVocabulary = (project: CirceMeshProject): ReadonlyArray<string> => {
  const workspaceName = project.workspaceRoot.split(/[\\/]/u).at(-1);
  return [
    project.title,
    project.workspaceRoot,
    ...(workspaceName === undefined ? [] : [workspaceName]),
    ...project.repositoryNames,
  ];
};

const projectInstructionVocabulary = (project: CirceMeshProject): ReadonlyArray<string> => [
  ...projectExactVocabulary(project),
  ...project.aliases,
];

/**
 * Every matchable name for proposal grounding: title, workspace basename,
 * repository names, and exact aliases. Phonetic matching never applies;
 * the proposal must cite the heard text exactly.
 */
export function meshProjectMatchNames(project: CirceMeshProject): ReadonlyArray<string> {
  return [...projectInstructionVocabulary(project)];
}

/** Resolve only canonical names and saved aliases; phonetic matching belongs to the voice adapter. */
export function resolveCirceMeshProject(
  catalog: CirceMeshCatalog,
  query: string,
): CirceMeshProjectResolution {
  const normalizedQuery = normalize(query);
  if (normalizedQuery.length === 0) return { status: "not-found" };

  const exact = uniqueProjects(
    catalog.projects.filter((project) =>
      projectExactVocabulary(project).some((value) => normalize(value) === normalizedQuery),
    ),
  );
  if (exact.length === 1) {
    return { status: "resolved", project: exact[0]! };
  }
  if (exact.length > 1) {
    return {
      status: "needs-clarification",
      candidates: exact.map((project) => ({ ...project, label: projectLabel(project) })),
    };
  }

  const aliases = uniqueProjects(
    catalog.projects.filter((project) =>
      project.aliases.some((alias) => normalize(alias) === normalizedQuery),
    ),
  );
  if (aliases.length === 1) {
    return { status: "resolved", project: aliases[0]! };
  }
  if (aliases.length > 1) {
    return {
      status: "needs-clarification",
      candidates: aliases.map((project) => ({ ...project, label: projectLabel(project) })),
    };
  }
  return { status: "not-found" };
}

/**
 * Semantic-node selection without reading the utterance. The interpret call
 * must happen before irreversible routing, so the node pick cannot depend on
 * prepositions, regex, or inferred destinations. Prefer the ambient project
 * node when it is online; otherwise use the first online node. Returns
 * undefined when no node is online, so callers report availability instead
 * of guessing.
 */
export function selectCirceSemanticNode(
  catalog: CirceMeshCatalog,
  ambientNodeId?: EnvironmentId,
): CirceMeshNode | undefined {
  const online = catalog.nodes.filter((node) => node.reachability === "online");
  if (online.length === 0) return undefined;
  if (ambientNodeId !== undefined) {
    const ambient = online.find((node) => node.nodeId === ambientNodeId);
    if (ambient !== undefined) return ambient;
  }
  return online[0];
}

/**
 * Whether a node advertises a preset that can run a bounded quick lookup.
 * Lookups need a Full or Controller surface; a Headless node refuses them
 * before any network call. Capabilities are required, so a node with unknown
 * capabilities is never treated as capable.
 */
function circeMeshNodeSupportsQuickLookup(node: CirceMeshNode): boolean {
  return (
    node.reachability === "online" &&
    node.capabilities !== undefined &&
    node.capabilities.preset !== "headless"
  );
}

/**
 * Pick the node that runs a bounded quick lookup. Prefer the given nodes in
 * order when they are online and lookup-capable, then the first capable node.
 * Returns undefined when no node advertises the capability, so a caller can
 * fall back to its semantic node or report unavailability instead of silently
 * routing the lookup to a Headless node.
 */
export function selectCirceQuickLookupNode(
  catalog: CirceMeshCatalog,
  preferredNodeIds: ReadonlyArray<EnvironmentId | null | undefined> = [],
): CirceMeshNode | undefined {
  const capable = catalog.nodes.filter(circeMeshNodeSupportsQuickLookup);
  for (const nodeId of preferredNodeIds) {
    if (nodeId === null || nodeId === undefined) continue;
    const preferred = capable.find((node) => node.nodeId === nodeId);
    if (preferred !== undefined) return preferred;
  }
  return capable[0];
}

/**
 * Pick the node that can actually drive a device surface right now. A node is
 * eligible when it is online, not Headless, and its observed readiness says
 * the requested surface is ready. Preset capability alone is not enough: a
 * running server with no active session or no granted permission must not be
 * chosen. Returns undefined when no node reports a ready surface.
 */
export function selectCirceDeviceTargetNode(input: {
  readonly catalog: CirceMeshCatalog;
  readonly surface: "browser" | "preview" | "computer";
  readonly readiness: ReadonlyMap<EnvironmentId, CirceDeviceReadiness>;
  readonly preferredNodeIds?: ReadonlyArray<EnvironmentId | null | undefined>;
}): { readonly node: CirceMeshNode; readonly readiness: CirceDeviceReadiness } | undefined {
  const eligible = input.catalog.nodes.flatMap((node) => {
    if (!circeMeshNodeSupportsQuickLookup(node)) return [];
    const readiness = input.readiness.get(node.nodeId);
    if (readiness === undefined || readiness.controlAllowed !== true) return [];
    const surface = readiness.surfaces.find((entry) => entry.surface === input.surface);
    if (surface?.ready !== true) return [];
    return [{ node, readiness }];
  });
  for (const nodeId of input.preferredNodeIds ?? []) {
    if (nodeId === null || nodeId === undefined) continue;
    const preferred = eligible.find((entry) => entry.node.nodeId === nodeId);
    if (preferred !== undefined) return preferred;
  }
  return eligible[0];
}

export interface CirceMeshInterpretEvidenceOptions {
  readonly currentProjectTitle?: string;
  readonly focusedTask?: { readonly title: string; readonly project?: string };
  readonly continueContext?: boolean;
  readonly pendingHint?: CirceInterpretInput["pendingHint"];
  readonly inputMode?: "voice" | "text";
  /** Bounded device tools this client can run, so the semantic node offers them. */
  readonly clientTools?: CirceInterpretInput["clientTools"];
  readonly clientToolCandidates?: CirceInterpretInput["clientToolCandidates"];
  readonly tasks?: ReadonlyArray<{
    readonly title: string;
    readonly project?: string;
    readonly objective?: string;
    readonly state?: string;
  }>;
  readonly requestMetadata?: CirceInterpretInput["requestMetadata"];
}

/**
 * Build the bounded untrusted evidence for one interpret call from the live
 * mesh catalog. Names only, never IDs; the semantic node proposes and both
 * hosts validate. Caps keep the prompt bounded on large meshes. Tasks come
 * from the fresh desk read (same 8-task window the direct wire prompts), so
 * a per-source proposal sees the same names as a direct local inference.
 */
export function buildCirceInterpretInput(
  catalog: CirceMeshCatalog,
  source: string,
  options: CirceMeshInterpretEvidenceOptions = {},
): CirceInterpretInput {
  const projects = catalog.projects.slice(0, 32).map((project) => ({
    title: project.title.slice(0, 240),
    names: meshProjectMatchNames(project)
      .slice(0, 12)
      .map((name) => name.slice(0, 240)),
  }));
  const providerNames = new Map<string, string>();
  for (const provider of catalog.providers) {
    const name = provider.snapshot.displayName ?? provider.snapshot.driver ?? "provider";
    const key = name.toLocaleLowerCase("en-US");
    if (!providerNames.has(key)) providerNames.set(key, name.slice(0, 120));
    if (providerNames.size >= 16) break;
  }
  // Devices are routing targets the supervisor may cite. Labels only, never
  // IDs: the client grounds the label to its owning node. Deduplicated by
  // folded label so a repeated name does not imply a choice it cannot make.
  const nodeLabels = new Map<string, string>();
  for (const node of catalog.nodes) {
    const label = node.label.trim().slice(0, 120);
    if (label.length === 0) continue;
    const key = label.toLocaleLowerCase("en-US");
    if (!nodeLabels.has(key)) nodeLabels.set(key, label);
    if (nodeLabels.size >= 16) break;
  }
  const nodes = [...nodeLabels.values()].map((label) => ({ label }));
  const tasks = (options.tasks ?? []).slice(0, 8).map((task) => ({
    title: task.title.slice(0, 240),
    ...(task.project === undefined ? {} : { project: task.project.slice(0, 240) }),
    ...(task.objective === undefined ? {} : { objective: task.objective.slice(0, 480) }),
    ...(task.state === undefined ? {} : { state: task.state.slice(0, 64) }),
  }));
  return {
    utterance: source.slice(0, 16_000),
    projects,
    tasks,
    providers: [...providerNames.values()].map((name) => ({ name })),
    nodes,
    ...(options.currentProjectTitle === undefined
      ? {}
      : { currentProjectTitle: options.currentProjectTitle.slice(0, 240) }),
    ...(options.focusedTask === undefined ? {} : { focusedTask: options.focusedTask }),
    ...(options.continueContext === undefined ? {} : { continueContext: options.continueContext }),
    ...(options.pendingHint === undefined ? {} : { pendingHint: options.pendingHint }),
    ...(options.inputMode === undefined ? {} : { inputMode: options.inputMode }),
    ...(options.clientTools === undefined ? {} : { clientTools: options.clientTools }),
    ...(options.clientToolCandidates === undefined
      ? {}
      : { clientToolCandidates: options.clientToolCandidates }),
    ...(options.requestMetadata === undefined ? {} : { requestMetadata: options.requestMetadata }),
  };
}

/**
 * Fold one heard value exactly like the host validator, so client grounding
 * and server validation agree on what matches. Shared here so routeGrounding
 * needs no regex of its own.
 */
export function foldCirceMeshName(value: string): string {
  return normalizeDestinationPhrase(stripDestinationQuotes(value));
}

const reachability = (phase: SupervisorConnectionPhase): CirceMeshReachability =>
  phase === "connected" ? "online" : "offline";

const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);
const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const catalogErrorKind = (error: unknown): CirceMeshCatalogErrorKind => {
  if (isEnvironmentRpcUnavailableError(error) || isConnectionTransientError(error)) {
    return "unreachable";
  }
  if (isConnectionBlockedError(error)) {
    return error.reason === "authentication" || error.reason === "permission"
      ? "authentication"
      : error.reason === "unsupported"
        ? "incompatible"
        : "service";
  }
  if (isEnvironmentAuthorizationError(error)) {
    return "authentication";
  }
  if (isRpcClientError(error)) {
    switch (error.reason._tag) {
      case "SocketOpenError":
      case "SocketReadError":
      case "SocketWriteError":
      case "SocketCloseError":
        return "unreachable";
      case "RpcClientDefect":
        return "incompatible";
      default:
        return "service";
    }
  }
  return "service";
};

const catalogErrorMessage = (kind: CirceMeshCatalogErrorKind, error: unknown): string => {
  switch (kind) {
    case "unreachable":
      return "Node is unreachable; reconnect it and retry catalog refresh.";
    case "authentication":
      return "Node authentication failed; reconnect with a valid pairing link.";
    case "incompatible":
      return "Node returned an incompatible Circe catalog; update both devices and retry.";
    case "service":
      return error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Circe catalog unavailable.";
  }
};

const availableProvider = (provider: ServerProvider): boolean =>
  isProviderAvailable(provider) &&
  provider.enabled &&
  provider.installed &&
  provider.status === "ready" &&
  provider.auth.status !== "unauthenticated";

interface NodeRead {
  readonly node: CirceMeshNode;
  readonly projects: ReadonlyArray<CirceMeshProject>;
  readonly providers: ReadonlyArray<CirceMeshProvider>;
}

export type CirceMeshNodeRecoveryAction = "retry" | "reconnect" | "reauthenticate" | "update";

export type CirceMeshNodeReadiness =
  | { readonly status: "ready" }
  | { readonly status: "loading" }
  | {
      readonly status: "unavailable";
      readonly message: string;
      readonly recovery: CirceMeshNodeRecoveryAction;
    };

export interface CirceMeshNodeReadinessInput {
  readonly nodeId?: unknown;
  readonly label?: string;
  readonly reachability: CirceMeshReachability;
  readonly catalogPending?: boolean;
  readonly catalogError?: string;
  readonly catalogErrorKind?: CirceMeshCatalogErrorKind;
}

/**
 * One shared per-node readiness policy. Loading means a catalog read is still
 * in flight. Ready means the catalog read finished, even when it legitimately
 * holds zero projects. Unavailable keeps the node's actual message and names
 * the recovery that fits its classification.
 */
export function circeMeshNodeReadiness(node: CirceMeshNodeReadinessInput): CirceMeshNodeReadiness {
  if (node.catalogPending === true) return { status: "loading" };
  if (node.reachability !== "online") {
    return {
      status: "unavailable",
      message:
        node.catalogError ??
        `${node.label ?? "Node"} is offline; reconnect it and retry catalog refresh.`,
      recovery:
        node.catalogErrorKind === "authentication"
          ? "reauthenticate"
          : node.catalogErrorKind === "incompatible"
            ? "update"
            : "reconnect",
    };
  }
  if (node.catalogError !== undefined) {
    return {
      status: "unavailable",
      message: node.catalogError,
      recovery:
        node.catalogErrorKind === "authentication"
          ? "reauthenticate"
          : node.catalogErrorKind === "incompatible"
            ? "update"
            : node.catalogErrorKind === "unreachable"
              ? "reconnect"
              : "retry",
    };
  }
  return { status: "ready" };
}

/**
 * Nodes whose catalog could not be read while they look connected. Name
 * resolution against such a catalog is partial: an unqualified name that
 * resolves here might also exist on an unread node, so callers must clarify
 * or report availability instead of guessing.
 */
export function circeMeshCatalogCoverage(catalog: CirceMeshCatalog): {
  readonly complete: boolean;
  readonly unavailableNodeLabels: ReadonlyArray<string>;
} {
  const unavailableNodeLabels = catalog.nodes
    .filter((node) => circeMeshNodeReadiness(node).status !== "ready")
    .map((node) => node.label);
  return { complete: unavailableNodeLabels.length === 0, unavailableNodeLabels };
}

export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const catalogRef = yield* SubscriptionRef.make<CirceMeshCatalog>(EMPTY_CATALOG);

  const mergeNodeRead = (current: CirceMeshCatalog, read: NodeRead): CirceMeshCatalog => {
    const nodes = current.nodes.some((node) => node.nodeId === read.node.nodeId)
      ? current.nodes.map((node) => (node.nodeId === read.node.nodeId ? read.node : node))
      : [...current.nodes, read.node];
    return {
      nodes,
      projects: [
        ...current.projects.filter((project) => project.ref.nodeId !== read.node.nodeId),
        ...read.projects,
      ],
      providers: [
        ...current.providers.filter((provider) => provider.nodeId !== read.node.nodeId),
        ...read.providers,
      ],
    };
  };

  const nodeRead = Effect.fn("CirceMesh.readNode")(function* (
    entry: ConnectionCatalogEntry,
  ): Effect.fn.Return<NodeRead, CatalogError> {
    const target = entry.target;
    const state = yield* registry.state(target.environmentId);
    const currentNode: CirceMeshNode = {
      nodeId: target.environmentId,
      label: target.label,
      reachability: reachability(state.phase),
    };
    if (state.phase !== "connected") {
      return {
        node: currentNode,
        projects: [],
        providers: [],
      };
    }

    const live = yield* registry.run(
      target.environmentId,
      Effect.all(
        {
          vocabulary: getCirceProjectVocabulary(),
          config: request(WS_METHODS.serverGetConfig, {}),
        },
        { concurrency: 2 },
      ),
    );
    const capabilities = live.config.environment?.capabilities?.circeNode;
    if (capabilities === undefined) {
      return {
        node: {
          ...currentNode,
          catalogError: "This node does not advertise current Circe capabilities.",
          catalogErrorKind: "incompatible",
        },
        projects: [],
        providers: [],
      };
    }
    const liveLabel = live.config.environment?.label ?? target.label;
    const projects = live.vocabulary.map((project): CirceMeshProject => ({
      ...project,
      nodeId: target.environmentId,
      ref: {
        nodeId: target.environmentId,
        projectId: project.projectId,
      },
      nodeLabel: liveLabel,
    }));
    const providers = live.config.providers.map((snapshot): CirceMeshProvider => ({
      nodeId: target.environmentId,
      nodeLabel: liveLabel,
      snapshot,
      available: availableProvider(snapshot),
    }));
    // The node advertises both its configured supervisor instance (via
    // settings) and its provider snapshot: false only when a successful
    // read confirms that exact instance is unavailable. Missing settings
    // stay unknown so the normal execute fallback remains eligible.
    const supervisorInstanceId = live.config.settings?.circeSupervisorModelSelection?.instanceId;
    const conversationReady =
      supervisorInstanceId === undefined
        ? undefined
        : providers.some(
            (provider) =>
              provider.available && provider.snapshot.instanceId === supervisorInstanceId,
          );
    return {
      node: { ...currentNode, label: liveLabel, capabilities, conversationReady },
      projects,
      providers,
    };
  });

  const readsInFlight = new Map<EnvironmentId, object>();

  const prepareCatalog = (entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>) =>
    SubscriptionRef.update(catalogRef, (current) => ({
      nodes: [...entries.values()].map(
        (entry) =>
          current.nodes.find((node) => node.nodeId === entry.target.environmentId) ?? {
            nodeId: entry.target.environmentId,
            label: entry.target.label,
            reachability: "offline" as const,
            catalogPending: true,
          },
      ),
      projects: current.projects.filter((project) => entries.has(project.ref.nodeId)),
      providers: current.providers.filter((provider) => entries.has(provider.nodeId)),
    }));

  const refreshEntry = Effect.fn("CirceMesh.refreshEntry")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const nodeId = entry.target.environmentId;
    const token = {};
    readsInFlight.set(nodeId, token);
    yield* SubscriptionRef.update(catalogRef, (current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.nodeId === nodeId ? { ...node, catalogPending: true } : node,
      ),
    }));
    const read = yield* nodeRead(entry).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const state = yield* registry
            .state(entry.target.environmentId)
            .pipe(Effect.orElseSucceed(() => ({ phase: "offline" as const })));
          const kind = catalogErrorKind(error);
          const node: CirceMeshNode = {
            nodeId: entry.target.environmentId,
            label: entry.target.label,
            // A connected state is not enough to claim a reachable node when
            // its catalog probe failed at the transport boundary. Readiness
            // stays unknown: the probe never confirmed the supervisor.
            reachability: kind === "unreachable" ? "offline" : reachability(state.phase),
            catalogErrorKind: kind,
            catalogError: catalogErrorMessage(kind, error),
          };
          return { node, projects: [], providers: [] } satisfies NodeRead;
        }),
      ),
    );
    const entries = yield* SubscriptionRef.get(registry.entries);
    if (readsInFlight.get(nodeId) === token) {
      readsInFlight.delete(nodeId);
      if (entries.get(nodeId) === entry) {
        yield* SubscriptionRef.update(catalogRef, (current) => mergeNodeRead(current, read));
      }
    }
    yield* prepareCatalog(entries);
  });

  const refresh = Effect.gen(function* () {
    const entries = yield* SubscriptionRef.get(registry.entries);
    yield* prepareCatalog(entries);
    yield* Effect.forEach([...entries.values()], refreshEntry, {
      concurrency: CIRCE_MESH_REFRESH_CONCURRENCY,
      discard: true,
    });
    return yield* SubscriptionRef.get(catalogRef);
  });

  const refreshNode = Effect.fn("CirceMesh.refreshNode")(function* (nodeId: EnvironmentId) {
    const entries = yield* SubscriptionRef.get(registry.entries);
    const entry = entries.get(nodeId);
    if (entry === undefined) {
      return yield* new EnvironmentNotRegisteredError({ environmentId: nodeId });
    }
    yield* prepareCatalog(entries);
    yield* refreshEntry(entry);
    return yield* SubscriptionRef.get(catalogRef);
  });

  const connectedNode = Effect.fn("CirceMesh.connectedNode")(function* (nodeId: EnvironmentId) {
    const entries = yield* SubscriptionRef.get(registry.entries);
    const entry = entries.get(nodeId);
    if (entry === undefined) {
      return yield* new EnvironmentNotRegisteredError({ environmentId: nodeId });
    }
    const state = yield* registry.state(nodeId);
    if (state.phase !== "connected") {
      return yield* new CirceMeshNodeUnavailableError({
        nodeId,
        label: entry.target.label,
        phase: state.phase,
      });
    }
    return entry;
  });

  const interpret = Effect.fn("CirceMesh.interpret")(function* (input: CirceMeshInterpretInput) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, interpretCirceInstruction(input.interpret));
  });

  const execute = Effect.fn("CirceMesh.execute")(function* (input: CirceMeshExecuteInput) {
    yield* connectedNode(input.projectRef.nodeId);
    return yield* registry.run(
      input.projectRef.nodeId,
      executeCirceInstruction({
        ...input,
        projectId: input.projectRef.projectId,
        projectRef: input.projectRef,
        requestMetadata: input.requestMetadata,
      }),
    );
  });

  const getTaskDesk = Effect.fn("CirceMesh.getTaskDesk")(function* (nodeId: EnvironmentId) {
    yield* connectedNode(nodeId);
    return yield* registry.run(nodeId, getCirceTaskDesk());
  });

  const focusTask = Effect.fn("CirceMesh.focusTask")(function* (input: CirceMeshFocusTaskInput) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, focusCirceTask(input.task));
  });

  const submitInteraction = Effect.fn("CirceMesh.submitInteraction")(function* (input: {
    readonly nodeId: EnvironmentId;
    readonly input: CirceInteractionSubmitInput;
  }) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, submitCirceInteraction(input.input));
  });

  const readInteraction = Effect.fn("CirceMesh.readInteraction")(function* (input: {
    readonly nodeId: EnvironmentId;
    readonly interactionId?: CirceInteractionId | undefined;
  }) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(
      input.nodeId,
      readCirceInteraction(
        input.interactionId === undefined ? {} : { interactionId: input.interactionId },
      ),
    );
  });

  const interruptInteraction = Effect.fn("CirceMesh.interruptInteraction")(function* (input: {
    readonly nodeId: EnvironmentId;
    readonly input: CirceInteractionInterruptInput;
  }) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, interruptCirceInteraction(input.input));
  });

  const deviceReadiness = Effect.fn("CirceMesh.deviceReadiness")(function* (nodeId: EnvironmentId) {
    yield* connectedNode(nodeId);
    return yield* registry.run(nodeId, getCirceDeviceReadiness({}));
  });

  const computerStatus = Effect.fn("CirceMesh.computerStatus")(function* (nodeId: EnvironmentId) {
    yield* connectedNode(nodeId);
    return yield* registry.run(nodeId, getCirceComputerStatus());
  });

  const computerUse = Effect.fn("CirceMesh.computerUse")(function* (input: {
    readonly nodeId: EnvironmentId;
    readonly input: CirceComputerUseInput;
  }) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, useCirceComputer(input.input));
  });

  const cancelMission = Effect.fn("CirceMesh.cancelMission")(function* (input: {
    readonly nodeId: EnvironmentId;
    readonly input: CirceCancelMissionInput;
  }) {
    yield* connectedNode(input.nodeId);
    return yield* registry.run(input.nodeId, cancelCirceMission(input.input));
  });

  const cancelRequest = Effect.fn("CirceMesh.cancelRequest")(function* (
    nodeId: EnvironmentId,
    input: CirceCancelRequestInput,
  ) {
    yield* connectedNode(nodeId);
    return yield* registry.run(nodeId, cancelCirceRequest(input));
  });

  const manageAlias = Effect.fn("CirceMesh.manageProjectAlias")(function* (
    input: CirceMeshManageProjectAliasInput,
  ) {
    yield* connectedNode(input.projectRef.nodeId);
    const { projectRef, ...alias } = input;
    return yield* registry.run(
      projectRef.nodeId,
      manageCirceProjectAlias({
        ...alias,
        projectId: projectRef.projectId,
        nodeId: projectRef.nodeId,
      }),
    );
  });

  const converse = Effect.fn("CirceMesh.converse")(function* (input: CirceMeshConverseInput) {
    yield* connectedNode(input.nodeId);
    // The cached catalog is the node's own advertised capability: refuse a
    // node whose configured supervisor is known-unavailable instead of
    // sending a question it can only fail.
    const catalog = yield* SubscriptionRef.get(catalogRef);
    const cached = catalog.nodes.find((node) => node.nodeId === input.nodeId);
    if (cached !== undefined && cached.conversationReady === false) {
      return yield* new CirceMeshConversationUnavailableError({
        nodeId: input.nodeId,
        label: cached.label,
      });
    }
    return yield* registry.run(
      input.nodeId,
      executeCirceInstruction({
        kind: "converse",
        utterance: input.utterance,
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
      }),
    );
  });

  return CirceMesh.of({
    catalogChanges: SubscriptionRef.changes(catalogRef).pipe(
      Stream.drainFork(
        SubscriptionRef.changes(registry.entries).pipe(
          Stream.switchMap((entries) =>
            Stream.fromEffect(prepareCatalog(entries)).pipe(
              Stream.flatMap(() =>
                Stream.mergeAll(
                  [...entries.values()].map((entry) =>
                    registry.stateChanges(entry.target.environmentId).pipe(
                      Stream.map((state) => state.phase),
                      Stream.changes,
                      Stream.mapEffect(() => refreshEntry(entry)),
                      Stream.catch(() => Stream.empty),
                    ),
                  ),
                  { concurrency: "unbounded" },
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    refresh,
    refreshNode,
    computerStatus,
    computerUse,
    cancelMission,
    resolveProject: (query) =>
      SubscriptionRef.get(catalogRef).pipe(
        Effect.map((catalog) => resolveCirceMeshProject(catalog, query)),
      ),
    interpret,
    execute,
    converse,
    getTaskDesk,
    submitInteraction,
    readInteraction,
    interruptInteraction,
    deviceReadiness,
    focusTask,
    cancelRequest,
    manageProjectAlias: manageAlias,
  });
});

export const layer = Layer.effect(CirceMesh, make);
