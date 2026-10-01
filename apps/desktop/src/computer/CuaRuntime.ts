import type { CuaDriverLike } from "@trycua/cua-driver";
import * as Schema from "effect/Schema";

/**
 * One lazily started Cua runtime inside the Electron main process. The runtime
 * owns the OS session; nothing here makes policy decisions. Calls are
 * dispatchable JSON tool calls so the host stays a relay and the driver's
 * typed surface remains the driver's own concern.
 */

interface CuaDriverModule {
  readonly CuaDriver: {
    create(options: undefined): CuaDriverLike;
  };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const DriverToolManifest = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      inputSchema: Schema.optional(
        Schema.Struct({
          properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    }),
  ),
});
const decodeDriverToolManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(DriverToolManifest),
);

export type CuaRuntimeState = "stopped" | "starting" | "ready" | "failed";

export interface CuaRuntimeMetadata {
  readonly driverVersion: string;
  readonly contractVersion: string;
  readonly pid: number;
  readonly embedded: boolean;
}

/**
 * What the loaded driver advertises, read once from its own tool manifest.
 * Capabilities come from this, not from the driver version: a stock build
 * and a perception-capable build of the same version differ here.
 */
export interface CuaToolManifest {
  readonly tools: ReadonlySet<string>;
  /** Tools whose schema accepts the driver's `session` label. */
  readonly sessionAware: ReadonlySet<string>;
  /** `click` accepts a `capture_id` that binds the point to one capture. */
  readonly captureBoundClick: boolean;
}

export interface CuaRuntimeOptions {
  /** Test seam: replace the dynamic import of `@trycua/cua-driver`. */
  readonly load?: () => Promise<unknown>;
  readonly requestTimeoutMs?: number;
  /**
   * Driver state home (`CUA_DRIVER_RS_HOME`). Circe keeps its own so its
   * extension store and publisher trust never mix with a separate Cua install.
   */
  readonly home?: string;
  /** Signed perception catalog the driver's `install_extension` reads. */
  readonly perceptionCatalog?: string;
  /** Test seam for the process environment the driver reads. */
  readonly environment?: NodeJS.ProcessEnv;
}

export class CuaRuntimeUnavailableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "CuaRuntimeUnavailableError";
  }
}

const linkSignals = (signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal => {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return new AbortController().signal;
  if (active.length === 1) return active[0]!;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
};

const withTimeout = (signal: AbortSignal, timeoutMs: number): AbortSignal =>
  linkSignals([signal, AbortSignal.timeout(timeoutMs)]);

export class CuaRuntime {
  private closed = false;
  private driver: CuaDriverLike | undefined;
  private starting: Promise<CuaDriverLike> | undefined;
  private runState: CuaRuntimeState = "stopped";
  private failureReason: string | undefined;
  private readonly inFlight = new Set<AbortController>();
  private readonly requestTimeoutMs: number;
  private readonly load: () => Promise<unknown>;
  private readonly home: string | undefined;
  private readonly catalog: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private manifest: Promise<CuaToolManifest> | undefined;

  constructor(options: CuaRuntimeOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.load =
      options.load ?? (() => import("@trycua/cua-driver").then((module) => module as unknown));
    this.home = options.home;
    this.catalog = options.perceptionCatalog;
    this.environment = options.environment ?? process.env;
  }

  get perceptionCatalog(): string | undefined {
    return this.catalog;
  }

  get state(): CuaRuntimeState {
    return this.runState;
  }

  get reason(): string | undefined {
    return this.failureReason;
  }

  get available(): boolean {
    return this.driver?.isAvailable() === true;
  }

  /**
   * The driver's advertised tools, read once per runtime. The host injects the
   * mission label only into session-aware calls, so unlabeled calls cannot
   * outlive the named session. A manifest that cannot be decoded is an error,
   * not an empty manifest; a failed read is retried on the next request.
   */
  toolManifest(): Promise<CuaToolManifest> {
    if (this.closed)
      return Promise.reject(new CuaRuntimeUnavailableError("Cua runtime is shut down."));
    if (this.manifest !== undefined) return this.manifest;
    const read = (async () => {
      const driver = await this.ensureStarted();
      const decoded = decodeDriverToolManifest(await driver.listToolsJson());
      if (decoded._tag === "None")
        throw new CuaRuntimeUnavailableError("The driver tool manifest could not be decoded.");
      const tools = decoded.value.tools;
      const properties = (name: string) =>
        tools.find((tool) => tool.name === name)?.inputSchema?.properties;
      return {
        tools: new Set(tools.map((tool) => tool.name)),
        sessionAware: new Set(
          tools.flatMap((tool) =>
            tool.inputSchema?.properties?.session === undefined ? [] : [tool.name],
          ),
        ),
        captureBoundClick: properties("click")?.capture_id !== undefined,
      } satisfies CuaToolManifest;
    })();
    this.manifest = read;
    read.catch(() => {
      if (this.manifest === read) this.manifest = undefined;
    });
    return read;
  }

  async metadata(): Promise<CuaRuntimeMetadata> {
    const driver = await this.ensureStarted();
    this.requireOpen();
    const metadata = await driver.metadata();
    return {
      driverVersion: String(metadata.driverVersion),
      contractVersion: String(metadata.contractVersion),
      pid: Number(metadata.pid),
      embedded: Boolean(metadata.embedded),
    };
  }

  /**
   * Dispatch one driver tool call. The timeout covers admission and dispatch;
   * an aborted mutation leaves uncertainty to the caller, which must not be
   * treated as a refusal to act.
   */
  async callTool(
    name: string,
    args: unknown,
    options: { readonly signal?: AbortSignal | undefined } = {},
  ): Promise<unknown> {
    const driver = await this.ensureStarted();
    this.requireOpen();
    const controller = new AbortController();
    this.inFlight.add(controller);
    const signal = withTimeout(
      linkSignals([options.signal, controller.signal]),
      this.requestTimeoutMs,
    );
    try {
      return await driver.callTool(name, JSON.stringify(args ?? {}), { signal });
    } catch (error) {
      this.noteCallFailure(error);
      throw error;
    } finally {
      this.inFlight.delete(controller);
    }
  }

  /** Abort every in-flight call. Used by Stop and input interruption. */
  interrupt(): void {
    for (const controller of this.inFlight) controller.abort(new Error("input-interrupted"));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.interrupt();
    this.manifest = undefined;
    const driver = this.driver;
    this.driver = undefined;
    this.starting = undefined;
    this.inFlight.clear();
    if (!driver) {
      this.runState = "stopped";
      return;
    }
    try {
      await releaseDriver(driver);
    } finally {
      this.runState = "stopped";
    }
  }

  private async ensureStarted(): Promise<CuaDriverLike> {
    this.requireOpen();
    if (this.driver && this.driver.isAvailable()) return this.driver;
    if (this.starting) return this.starting;
    // One startup at a time, published before anything awaits: concurrent
    // callers share it. A driver that stopped being available still holds
    // its native session, so the startup releases it first and only one
    // driver ever lives.
    const stale = this.driver;
    this.driver = undefined;
    this.manifest = undefined;
    this.runState = "starting";
    this.failureReason = undefined;
    const start = (async () => {
      try {
        if (stale) await releaseDriver(stale);
        this.requireOpen();
        // The driver reads these per call from the process environment; they
        // are set before the runtime exists so no call can see another home.
        if (this.home !== undefined) this.environment.CUA_DRIVER_RS_HOME = this.home;
        if (this.catalog !== undefined)
          this.environment.CUA_DRIVER_PERCEPTION_CATALOG = this.catalog;
        // DISPLAY also exists on Wayland desktops for XWayland clients. CUA's
        // native backend is opt-in; without it native apps launch but vanish
        // from discovery. An explicit override remains the user's choice.
        if (
          this.environment.WAYLAND_DISPLAY &&
          this.environment.CUA_DRIVER_RS_ENABLE_WAYLAND === undefined
        )
          this.environment.CUA_DRIVER_RS_ENABLE_WAYLAND = "1";
        const module = (await this.load()) as CuaDriverModule;
        this.requireOpen();
        const driver = module.CuaDriver.create(undefined);
        this.driver = driver;
        this.runState = "ready";
        return driver;
      } catch (error) {
        if (this.closed) {
          this.runState = "stopped";
          throw new CuaRuntimeUnavailableError("Cua runtime is shut down.", { cause: error });
        }
        this.runState = "failed";
        this.failureReason = error instanceof Error ? error.message : String(error);
        throw new CuaRuntimeUnavailableError(`Cua runtime failed to start: ${this.failureReason}`, {
          cause: error,
        });
      } finally {
        this.starting = undefined;
      }
    })();
    this.starting = start;
    return start;
  }

  private requireOpen(): void {
    if (this.closed) throw new CuaRuntimeUnavailableError("Cua runtime is shut down.");
  }

  /**
   * A call failure that leaves the native runtime unusable has to move the
   * host out of `ready`; otherwise the next call keeps pretending the runtime
   * is alive. Failures while the runtime is merely busy stay call-local.
   */
  private noteCallFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const looksFatal =
      /not available|unavailable|shut ?down|terminated|panicked|poisoned|broken/i.test(message);
    if (!looksFatal) return;
    if (this.driver?.isAvailable() === true) return;
    this.runState = "failed";
    this.failureReason = message;
  }
}

/** Shuts a driver down and releases its native handle, even when shutdown fails. */
async function releaseDriver(driver: CuaDriverLike): Promise<void> {
  try {
    await driver.shutdown();
  } catch {
    // Destruction below is the last reference release and must not be
    // skipped by a shutdown failure.
  } finally {
    if ("uniffiDestroy" in driver && typeof driver.uniffiDestroy === "function") {
      driver.uniffiDestroy();
    }
  }
}
