// @effect-diagnostics nodeBuiltinImport:off -- This is the socket adapter boundary: it owns a
// unix domain socket, its per-run directory mode, and named-pipe endpoint, which need node:fs,
// node:os, and node:path directly rather than the Effect layers.
// @effect-diagnostics globalDate:off -- Admission deadlines are wall-clock around a raw socket.
// @effect-diagnostics globalTimers:off -- The stop-settle bound is a raw timer around socket work.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  COMPUTER_HOST_MUTATION_TOOLS,
  COMPUTER_HOST_PROTOCOL_VERSION,
  COMPUTER_HOST_READ_TOOLS,
  ComputerHostHello,
  ComputerHostRequest,
  type ComputerHostBootstrap,
  type ComputerHostCapabilities,
  type ComputerHostEffect,
  type ComputerHostPlatform,
  type ComputerHostRefusalCode,
  type ComputerHostStatus,
  type ComputerHostToolResult,
  computerHostToolIsMutation,
} from "@circe/contracts";
import * as Schema from "effect/Schema";

import { HostProcessEnvironment, HostProcessPlatform } from "@circe/shared/hostProcess";

import { CuaRuntime, type CuaRuntimeState } from "./CuaRuntime.ts";

/**
 * The desktop host owns the Cua runtime and the OS session for one node. It
 * accepts exactly one authenticated server connection, relays dispatchable
 * tool calls, serializes them, revokes them on stop or disconnect, and reports
 * runtime state. Policy lives in the server; nothing here decides whether an
 * action is allowed, only whether it can physically run.
 *
 * Two lifetime rules shape this file:
 *
 * - Stop and end-mission are terminal. They bump the mission generation and
 *   abort in-flight work, so nothing already queued can execute afterwards.
 *   There is no implicit resume: a queued read never reauthorizes input.
 * - Every accepted queue entry is bound to the connection generation that
 *   admitted it. Replacing or losing the server connection revokes missions
 *   and fences their queued calls instead of letting them run unwatched.
 */

const CAPABILITY_BYTES = 32;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 16_384;
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64_CHARS = 4_000_000;
const STOP_SETTLE_TIMEOUT_MS = 2_000;
/** A read may run just past its caller's deadline; a mutation may not. */
const READ_DEADLINE_GRACE_MS = 250;
const PERMISSION_CACHE_MS = 15_000;

/**
 * Tools that accept Cua's optional `session` label, from the pinned 0.28.2
 * tool schemas. The host injects the mission's label here and ignores any
 * caller-supplied value, so the session that is closed is the session that
 * acted. `listToolsJson` refines this set at runtime when available.
 */
const DEFAULT_SESSION_AWARE_TOOLS: ReadonlySet<string> = new Set([
  "browser_click",
  "browser_dialog",
  "browser_download",
  "browser_navigate",
  "browser_pointer",
  "browser_prepare",
  "browser_set_input_files",
  "browser_type",
  "click",
  "clipboard_read",
  "clipboard_write",
  "double_click",
  "drag",
  "get_agent_cursor_state",
  "get_browser_state",
  "get_cursor_position",
  "get_desktop_state",
  "get_screen_size",
  "get_window_state",
  "hotkey",
  "invoke_menu",
  "mouse_button_down",
  "mouse_button_up",
  "mouse_drag",
  "move_cursor",
  "press_key",
  "right_click",
  "scroll",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  "set_value",
  "set_window_frame",
  "type_text",
  "verify_state",
]);

const MUTATION_TOOL_SET: ReadonlySet<string> = new Set(COMPUTER_HOST_MUTATION_TOOLS);
const READ_TOOL_SET: ReadonlySet<string> = new Set(COMPUTER_HOST_READ_TOOLS);
const decodeHello = Schema.decodeUnknownOption(ComputerHostHello);
const decodeRequest = Schema.decodeUnknownOption(ComputerHostRequest);

interface PendingCall {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly markSettled: () => void;
}

interface MissionState {
  readonly id: string;
  readonly sessionLabel: string;
  sessionOpen: boolean;
  revoked: boolean;
  readonly pending: Set<PendingCall>;
  /** One shared settlement-and-close run; every teardown path awaits it. */
  cleanup?: Promise<MissionCleanup>;
}

interface MissionCleanup {
  /** Dispatched work drained inside the bound. */
  readonly settled: boolean;
  /** The driver session was closed (or there was none to close). */
  readonly closed: boolean;
}

interface AdmittedCall {
  readonly epoch: number;
  readonly revocationEpoch: number;
  readonly admittedAtMs: number;
  readonly timeoutMs: number | undefined;
  readonly mutation: boolean;
}

interface DriverToolResultLike {
  readonly text?: unknown;
  readonly images?: unknown;
  readonly structuredJson?: unknown;
  readonly isError?: unknown;
  readonly errorCode?: unknown;
  readonly action?: unknown;
  readonly degraded?: unknown;
}

interface HostRequest {
  readonly id: string;
  readonly method: string;
  readonly missionId?: string | undefined;
  readonly tool?: string | undefined;
  readonly args?: unknown;
  readonly reason?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const parseStructured = (value: unknown): unknown => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const normalizeEffectName = (value: unknown): ComputerHostEffect | undefined => {
  if (
    value === "verified" ||
    value === "dispatched-unknown" ||
    value === "not-dispatched" ||
    value === "refused"
  )
    return value;
  return undefined;
};

const normalizeActionEffect = (value: unknown): ComputerHostEffect | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const effect = record.effect;
  if (effect === 0 || effect === "0" || effect === "Confirmed") return "verified";
  if (effect === 4 || effect === "4" || effect === "Refused") return "refused";
  if (effect === 1 || effect === "1" || effect === "Partial") return "dispatched-unknown";
  if (effect === 2 || effect === "2" || effect === "Unverifiable") return "dispatched-unknown";
  if (effect === 3 || effect === "3" || effect === "SuspectedNoop") return "dispatched-unknown";
  return undefined;
};

const normalizeImages = (value: unknown): ComputerHostToolResult["images"] => {
  if (!Array.isArray(value)) return [];
  const images: Array<{ mimeType: string; dataBase64: string }> = [];
  for (const item of value.slice(0, MAX_IMAGES)) {
    const record = asRecord(item);
    if (!record) continue;
    const mimeType = record.mimeType;
    const dataBase64 = record.dataBase64;
    if (typeof mimeType !== "string" || typeof dataBase64 !== "string") continue;
    if (dataBase64.length > MAX_IMAGE_BASE64_CHARS) continue;
    images.push({ mimeType, dataBase64 });
  }
  return images;
};

export interface ComputerHostOptions {
  readonly runtime?: CuaRuntime;
  readonly appVersion?: string;
  /** Test seam for the per-run socket directory. */
  readonly runtimeDirectory?: string;
  /** Injected host runtime references so tests do not read globals. */
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface CloseableComputerHost {
  readonly bootstrap: ComputerHostBootstrap;
  close(): Promise<void>;
}

export class ComputerHost {
  private readonly runtime: CuaRuntime;
  private readonly requestedDirectory: string | undefined;
  private readonly capability: string;
  private readonly hostPlatform: NodeJS.Platform;
  private readonly environment: NodeJS.ProcessEnv;
  private server: NodeNet.Server | undefined;
  private directory: string | undefined;
  private endpoint: string | undefined;
  private connection: NodeNet.Socket | undefined;
  private buffer = "";
  private helloComplete = false;
  private connectionEpoch = 0;
  private readonly missions = new Map<string, MissionState>();
  /** Revoked missions whose dispatched work or session close is still draining. */
  private readonly draining = new Map<string, MissionState>();
  private revocationEpoch = 0;
  private callChain: Promise<void> = Promise.resolve();
  private closed = false;
  private sessionTools: ReadonlySet<string> | undefined;
  private permissionCache: { readonly atMs: number; readonly value: unknown } | undefined;

  constructor(options: ComputerHostOptions = {}) {
    this.runtime = options.runtime ?? new CuaRuntime();
    this.requestedDirectory = options.runtimeDirectory;
    this.capability = NodeCrypto.randomBytes(CAPABILITY_BYTES).toString("hex");
    this.hostPlatform = options.platform ?? HostProcessPlatform.defaultValue();
    this.environment = options.environment ?? HostProcessEnvironment.defaultValue();
  }

  get runtimeState(): CuaRuntimeState {
    return this.runtime.state;
  }

  async listen(): Promise<ComputerHostBootstrap> {
    if (this.server) throw new Error("Computer host is already listening");
    const directory =
      this.requestedDirectory ??
      (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-computer-host-")));
    if (this.hostPlatform !== "win32") await NodeFSP.chmod(directory, 0o700);
    const endpoint =
      this.hostPlatform === "win32"
        ? `\\\\.\\pipe\\circe-computer-host-${NodeCrypto.randomUUID().slice(0, 8)}`
        : NodePath.join(directory, "host.sock");
    const server = NodeNet.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (this.hostPlatform !== "win32") await NodeFSP.chmod(endpoint, 0o600);
    this.directory = directory;
    this.endpoint = endpoint;
    return { endpoint, capability: this.capability, pid: process.pid };
  }

  async status(): Promise<ComputerHostStatus> {
    const graphical = this.hasGraphicalSession();
    const sessionType = this.sessionType();
    const runtimeFailed = this.runtime.state === "failed";
    const runtimeReady = this.runtime.state === "ready";
    const permissions = runtimeReady ? await this.probePermissions() : undefined;
    const permissionDenied =
      permissions !== undefined &&
      ((permissions as { atspi?: boolean }).atspi === false ||
        (permissions as { x11?: boolean }).x11 === false);
    const capabilities: ComputerHostCapabilities = {
      observe: graphical && !runtimeFailed,
      capture: graphical && !runtimeFailed,
      pointer: graphical && !runtimeFailed && !permissionDenied,
      keyboard: graphical && !runtimeFailed && !permissionDenied,
      windows: graphical && !runtimeFailed,
      browser: false,
    };
    const metadata = runtimeReady ? await this.tryMetadata() : undefined;
    const reason = !graphical
      ? "no graphical session for this process"
      : runtimeFailed
        ? (this.runtime.reason ?? "the Cua runtime failed to start")
        : permissionDenied
          ? "the driver reports no usable desktop input route"
          : undefined;
    return {
      available: graphical && !runtimeFailed,
      platform: this.platform,
      ...(sessionType ? { sessionType } : {}),
      runtime: this.runtime.state,
      ...(metadata ? { driverVersion: metadata.driverVersion, driverPid: metadata.pid } : {}),
      ...(permissions !== undefined ? { permissions } : {}),
      ...(reason ? { reason } : {}),
      capabilities,
    };
  }

  /**
   * Terminal interrupt for one mission, or every active mission. Aborted calls
   * settle as uncertain; a reply is only written after {@link settleMissions}
   * reports whether dispatched work finished.
   */
  interrupt(missionId?: string): ReadonlyArray<MissionState> {
    const missions = this.missionTargets(missionId);
    for (const mission of missions) this.revokeMission(mission, "interrupted");
    return missions;
  }

  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    this.connection = undefined;
    this.connectionEpoch += 1;
    connection?.destroy();
    const missions = [...this.missions.values()];
    for (const mission of missions) this.revokeMission(mission, "shutdown");
    await this.cleanupMissions(missions);
    this.missions.clear();
    this.draining.clear();
    await this.runtime.shutdown();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const directory = this.directory;
    this.directory = undefined;
    if (directory)
      await NodeFSP.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    this.endpoint = undefined;
  }

  private get platform(): ComputerHostPlatform {
    if (this.hostPlatform === "darwin") return "darwin";
    if (this.hostPlatform === "linux") return "linux";
    if (this.hostPlatform === "win32") return "win32";
    return "other";
  }

  private sessionType(): "wayland" | "x11" | "unknown" | undefined {
    if (this.hostPlatform !== "linux") return undefined;
    if ((this.environment.WAYLAND_DISPLAY ?? "").length > 0) return "wayland";
    if ((this.environment.DISPLAY ?? "").length > 0) return "x11";
    return "unknown";
  }

  private hasGraphicalSession(): boolean {
    if (this.hostPlatform === "darwin" || this.hostPlatform === "win32") return true;
    if (this.hostPlatform !== "linux") return false;
    return (
      (this.environment.WAYLAND_DISPLAY ?? "").length > 0 ||
      (this.environment.DISPLAY ?? "").length > 0
    );
  }

  private async tryMetadata(): Promise<{ driverVersion: string; pid: number } | undefined> {
    try {
      const metadata = await this.runtime.metadata();
      return { driverVersion: metadata.driverVersion, pid: metadata.pid };
    } catch {
      return undefined;
    }
  }

  /**
   * Driver-reported platform facts. This is evidence, not a promise: an
   * unavailable probe leaves permissions absent instead of inventing grants.
   */
  private async probePermissions(): Promise<unknown> {
    const now = Date.now();
    if (this.permissionCache && now - this.permissionCache.atMs < PERMISSION_CACHE_MS) {
      return this.permissionCache.value;
    }
    try {
      const result = await this.runtime.callTool("check_permissions", {});
      const record = asRecord(result);
      const structured = record ? parseStructured(record.structuredJson) : undefined;
      if (structured !== undefined) {
        this.permissionCache = { atMs: now, value: structured };
        return structured;
      }
    } catch {
      // The probe is optional; status falls back to runtime-level evidence.
    }
    return undefined;
  }

  private missionTargets(missionId?: string): ReadonlyArray<MissionState> {
    if (missionId === undefined) return [...this.missions.values()];
    const mission = this.missions.get(missionId);
    return mission === undefined ? [] : [mission];
  }

  /**
   * Revoke a mission: fence it immediately, then drain and close it in the
   * background. The mission stays in the draining map until its cleanup has
   * an answer, so stop, end and disconnect all observe the same outcome and
   * a later end-mission for the same id is idempotent instead of a no-op.
   */
  private revokeMission(mission: MissionState, reason: string): void {
    if (mission.revoked) return;
    mission.revoked = true;
    this.revocationEpoch += 1;
    this.missions.delete(mission.id);
    this.draining.set(mission.id, mission);
    for (const pending of mission.pending) {
      pending.controller.abort(new Error(reason));
    }
    void this.ensureCleanup(mission);
  }

  /** The one settlement-and-close operation shared by every teardown path. */
  private ensureCleanup(mission: MissionState): Promise<MissionCleanup> {
    if (mission.cleanup !== undefined) return mission.cleanup;
    mission.cleanup = (async () => {
      const settled = await this.settleMissions([mission]);
      let closed = true;
      if (mission.sessionOpen) {
        try {
          await this.runtime.callTool("end_session", { session: mission.sessionLabel });
        } catch {
          // The mission is already revoked; a session that cannot be closed is
          // reported as such and reclaimed when the runtime or host exits.
          closed = false;
        }
      }
      this.draining.delete(mission.id);
      return { settled, closed };
    })();
    return mission.cleanup;
  }

  private async cleanupMissions(missions: ReadonlyArray<MissionState>): Promise<MissionCleanup> {
    const results = await Promise.all(missions.map((mission) => this.ensureCleanup(mission)));
    return {
      settled: results.every((result) => result.settled),
      closed: results.every((result) => result.closed),
    };
  }

  /** Resolve when every pending call of these missions settles, or the bound lapses. */
  private async settleMissions(
    missions: ReadonlyArray<MissionState>,
    timeoutMs = STOP_SETTLE_TIMEOUT_MS,
  ): Promise<boolean> {
    const pending = missions.flatMap((mission) => [...mission.pending].map((call) => call.settled));
    if (pending.length === 0) return true;
    const settled = await Promise.race([
      Promise.allSettled(pending).then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    return settled === true;
  }

  /** Fence everything admitted under the old connection generation. */
  private revokeConnectionMissions(reason: string): void {
    const missions = [...this.missions.values()];
    for (const mission of missions) this.revokeMission(mission, reason);
    void this.cleanupMissions(missions);
  }

  private accept(socket: NodeNet.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    // A replacement connection is authenticated by its hello. Fence the old
    // generation first so its queued work can never execute afterwards.
    const previous = this.connection;
    if (previous) {
      this.connection = undefined;
      previous.destroy();
    }
    this.connectionEpoch += 1;
    this.revokeConnectionMissions(previous ? "connection-replaced" : "connection-reset");
    this.connection = socket;
    this.buffer = "";
    this.helloComplete = false;
    socket.setEncoding("utf8");
    socket.setTimeout(0);
    socket.on("data", (chunk: string) => this.consume(socket, chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.connection !== socket) return;
      this.connection = undefined;
      this.connectionEpoch += 1;
      this.revokeConnectionMissions("server-disconnected");
    });
  }

  private consume(socket: NodeNet.Socket, chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME_BYTES) {
      socket.destroy();
      this.buffer = "";
      return;
    }
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      void this.handleLine(socket, line).catch(() => socket.destroy());
      if (this.closed) return;
    }
  }

  private async handleLine(socket: NodeNet.Socket, line: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      socket.destroy();
      return;
    }
    if (!this.helloComplete) {
      const hello = decodeHello(value);
      if (
        hello._tag === "None" ||
        hello.value.protocol !== COMPUTER_HOST_PROTOCOL_VERSION ||
        !this.capabilityMatches(hello.value.capability)
      ) {
        socket.destroy();
        return;
      }
      this.helloComplete = true;
      return;
    }
    const request = decodeRequest(value);
    if (request._tag === "None") {
      const id =
        typeof (value as { id?: unknown }).id === "string"
          ? (value as { id: string }).id
          : "unknown";
      this.write(socket, {
        kind: "reply",
        id,
        ok: false,
        error: { code: "invalid-request", message: "Malformed computer host request." },
      });
      return;
    }
    await this.handleRequest(socket, request.value as HostRequest);
  }

  private capabilityMatches(supplied: string): boolean {
    const expected = Buffer.from(this.capability, "utf8");
    const actual = Buffer.from(supplied, "utf8");
    return expected.length === actual.length && NodeCrypto.timingSafeEqual(expected, actual);
  }

  private handleRequest(socket: NodeNet.Socket, request: HostRequest): Promise<void> {
    // Stop and end-mission are revocation paths: they must not wait behind
    // dispatched work, and they fence that work as their first act.
    if (request.method === "stop") {
      const active = this.interrupt(request.missionId);
      // A stop for an already-revoked mission still awaits its cleanup, so the
      // caller learns the real settlement instead of a fresh acknowledgement.
      const alreadyDraining =
        active.length === 0 && request.missionId !== undefined
          ? [this.draining.get(request.missionId)].filter(
              (mission): mission is MissionState => mission !== undefined,
            )
          : [];
      const missions = [...active, ...alreadyDraining];
      void this.cleanupMissions(missions).then((cleanup) =>
        this.write(socket, {
          kind: "reply",
          id: request.id,
          ok: true,
          result: { stopped: true, settled: cleanup.settled, closed: cleanup.closed },
        }),
      );
      return Promise.resolve();
    }
    if (request.method === "end-mission") {
      const active = this.missionTargets(request.missionId);
      for (const mission of active) this.revokeMission(mission, "mission-ended");
      const alreadyDraining =
        active.length === 0 && request.missionId !== undefined
          ? [this.draining.get(request.missionId)].filter(
              (mission): mission is MissionState => mission !== undefined,
            )
          : [];
      void this.cleanupMissions([...active, ...alreadyDraining]).then((cleanup) =>
        this.write(socket, {
          kind: "reply",
          id: request.id,
          ok: true,
          result: { ended: true, settled: cleanup.settled, closed: cleanup.closed },
        }),
      );
      return Promise.resolve();
    }
    if (request.method === "status") {
      return this.status().then(
        (status) => this.write(socket, { kind: "reply", id: request.id, ok: true, result: status }),
        (error: unknown) =>
          this.write(socket, {
            kind: "reply",
            id: request.id,
            ok: false,
            error: { code: "internal-error", message: String(error) },
          }),
      );
    }
    // Everything else is admitted now and executed in arrival order. The
    // admission captures the connection generation and deadline so a dequeue
    // after revocation or expiry refuses instead of executing unwatched.
    const admission: AdmittedCall = {
      epoch: this.connectionEpoch,
      revocationEpoch: this.revocationEpoch,
      admittedAtMs: Date.now(),
      timeoutMs: request.timeoutMs,
      mutation: request.tool !== undefined && computerHostToolIsMutation(request.tool),
    };
    const run = async (): Promise<void> => {
      const fenced = this.fenceAdmission(admission);
      if (fenced !== undefined) {
        this.write(socket, { kind: "reply", id: request.id, ok: true, result: fenced });
        return;
      }
      if (request.method === "begin-mission") {
        if (!request.missionId) {
          this.write(socket, {
            kind: "reply",
            id: request.id,
            ok: false,
            error: { code: "invalid-request", message: "A mission id is required." },
          });
          return;
        }
        const existing = this.missions.get(request.missionId);
        if (existing !== undefined) {
          this.write(socket, {
            kind: "reply",
            id: request.id,
            ok: true,
            result: { active: true, existing: true },
          });
          return;
        }
        if (this.missions.size > 0) {
          this.write(socket, {
            kind: "reply",
            id: request.id,
            ok: false,
            error: {
              code: "mission-conflict",
              message: "Another computer mission is already active.",
            },
          });
          return;
        }
        this.beginMission(request.missionId);
        this.write(socket, { kind: "reply", id: request.id, ok: true, result: { active: true } });
        return;
      }
      if (request.method === "call") {
        const result = await this.call(request.missionId, request.tool, request.args);
        this.write(socket, { kind: "reply", id: request.id, ok: true, result });
        return;
      }
      this.write(socket, {
        kind: "reply",
        id: request.id,
        ok: false,
        error: { code: "unsupported-method", message: `Unsupported method ${request.method}.` },
      });
    };
    const chained = this.callChain.then(run, run);
    this.callChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  /**
   * A refused tool result when the admission outlived its connection, its
   * revocation generation, or its deadline. A mutation has no post-expiry
   * grace: once the caller has stopped waiting, it must not be dispatched.
   */
  private fenceAdmission(admission: AdmittedCall): ComputerHostToolResult | undefined {
    if (this.closed) return this.refusal("host-shutdown", "The computer host is shutting down.");
    if (admission.epoch !== this.connectionEpoch)
      return this.refusal(
        "mission-ended",
        "The server connection changed before this call ran; the call was not executed.",
      );
    if (admission.revocationEpoch !== this.revocationEpoch)
      return this.refusal(
        "mission-ended",
        "A mission was stopped before this call ran; the call was not executed.",
      );
    if (admission.timeoutMs !== undefined) {
      const grace = admission.mutation ? 0 : READ_DEADLINE_GRACE_MS;
      if (Date.now() > admission.admittedAtMs + admission.timeoutMs + grace)
        return this.refusal(
          "timeout",
          "The caller stopped waiting before this call ran; the call was not executed.",
        );
    }
    return undefined;
  }

  beginMission(missionId: string): void {
    if (this.missions.has(missionId)) return;
    this.missions.set(missionId, {
      id: missionId,
      sessionLabel: `circe-${missionId}`,
      sessionOpen: false,
      revoked: false,
      pending: new Set(),
    });
  }

  private async call(
    missionId: string | undefined,
    tool: string | undefined,
    args: unknown,
  ): Promise<ComputerHostToolResult> {
    if (!missionId) return this.refusal("mission-required", "A mission id is required.");
    const mission = this.missions.get(missionId);
    if (!mission) return this.refusal("mission-ended", "No active mission with that id.");
    if (!tool || (!MUTATION_TOOL_SET.has(tool) && !READ_TOOL_SET.has(tool)))
      return this.refusal("tool-not-allowed", `Tool ${tool ?? "<none>"} is not available.`);
    const mutation = computerHostToolIsMutation(tool);

    let markSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const controller = new AbortController();
    const pending: PendingCall = { controller, settled, markSettled };
    mission.pending.add(pending);
    let dispatched = false;
    try {
      await this.ensureSession(mission);
      // Every session-aware call carries the mission's own label; a caller
      // value is overridden so the session that acts is the session that ends.
      const callArgs = await this.withMissionSession(mission, tool, args);
      dispatched = true;
      const raw = await this.runtime.callTool(tool, callArgs, { signal: controller.signal });
      return this.normalizeResult(raw, mutation);
    } catch (error) {
      if (this.runtime.state === "failed") this.emitDriverExit(mission);
      const aborted = controller.signal.aborted;
      return {
        isError: true,
        degraded: false,
        effect: mutation && dispatched ? "dispatched-unknown" : "not-dispatched",
        text: aborted
          ? "The action was interrupted; its delivery is unknown."
          : `The action failed before completion: ${
              error instanceof Error ? error.message : String(error)
            }`,
        refusalCode: aborted ? "input-interrupted" : "driver-refused",
        images: [],
      };
    } finally {
      mission.pending.delete(pending);
      markSettled();
    }
  }

  private async ensureSession(mission: MissionState): Promise<void> {
    if (mission.sessionOpen) return;
    await this.runtime.callTool("start_session", { session: mission.sessionLabel });
    mission.sessionOpen = true;
  }

  private async sessionAwareTools(): Promise<ReadonlySet<string>> {
    if (this.sessionTools !== undefined) return this.sessionTools;
    const discovered = await this.runtime.sessionAwareToolNames().catch(() => undefined);
    this.sessionTools = discovered ?? DEFAULT_SESSION_AWARE_TOOLS;
    return this.sessionTools;
  }

  private async withMissionSession(
    mission: MissionState,
    tool: string,
    args: unknown,
  ): Promise<unknown> {
    const aware = await this.sessionAwareTools();
    if (!aware.has(tool)) return args;
    const record = asRecord(args) ?? {};
    return { ...record, session: mission.sessionLabel };
  }

  private refusal(code: ComputerHostRefusalCode, message: string): ComputerHostToolResult {
    return {
      isError: true,
      degraded: false,
      effect: "refused",
      text: message,
      refusalCode: code,
      images: [],
    };
  }

  private normalizeResult(raw: unknown, mutation: boolean): ComputerHostToolResult {
    const record = (asRecord(raw) ?? {}) as DriverToolResultLike;
    const structured = parseStructured(record.structuredJson);
    const structuredRecord = asRecord(structured);
    const isError = record.isError === true;
    const errorCode = typeof record.errorCode === "string" ? record.errorCode : undefined;
    const effect =
      normalizeEffectName(structuredRecord?.effect) ??
      (errorCode ? "refused" : undefined) ??
      normalizeActionEffect(record.action) ??
      (isError ? "not-dispatched" : mutation ? "dispatched-unknown" : "verified");
    const text =
      typeof record.text === "string"
        ? record.text.slice(0, MAX_TEXT_CHARS)
        : isError
          ? "The driver reported an error without details."
          : "";
    return {
      isError,
      degraded: record.degraded === true,
      effect,
      text,
      ...(errorCode
        ? { refusalCode: errorCode.includes("interrupt") ? "input-interrupted" : "driver-refused" }
        : {}),
      ...(structured !== undefined ? { structured } : {}),
      images: isError ? [] : normalizeImages(record.images),
    };
  }

  private emitDriverExit(mission: MissionState): void {
    this.emit({
      event: "driver-exit",
      missionId: mission.id,
      detail: "The Cua runtime stopped; computer use is unavailable until it restarts.",
    });
  }

  private emit(event: {
    event: "input-interrupted" | "driver-exit" | "runtime-state" | "permission-changed";
    missionId?: string;
    detail?: string;
  }): void {
    this.write(this.connection, {
      kind: "event",
      protocol: COMPUTER_HOST_PROTOCOL_VERSION,
      ...event,
    });
  }

  private write(socket: NodeNet.Socket | undefined, message: unknown): void {
    if (!socket || socket.destroyed) return;
    try {
      socket.write(`${JSON.stringify(message)}\n`);
    } catch {
      socket.destroy();
    }
  }
}

export const openComputerHost = async (
  options: ComputerHostOptions = {},
): Promise<CloseableComputerHost> => {
  const host = new ComputerHost(options);
  const bootstrap = await host.listen();
  return { bootstrap, close: () => host.close() };
};
