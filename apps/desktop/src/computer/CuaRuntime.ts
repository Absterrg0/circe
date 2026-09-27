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

export interface CuaRuntimeOptions {
  /** Test seam: replace the dynamic import of `@trycua/cua-driver`. */
  readonly load?: () => Promise<unknown>;
  readonly requestTimeoutMs?: number;
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
  private driver: CuaDriverLike | undefined;
  private starting: Promise<CuaDriverLike> | undefined;
  private runState: CuaRuntimeState = "stopped";
  private failureReason: string | undefined;
  private readonly inFlight = new Set<AbortController>();
  private readonly requestTimeoutMs: number;
  private readonly load: () => Promise<unknown>;

  constructor(options: CuaRuntimeOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.load =
      options.load ?? (() => import("@trycua/cua-driver").then((module) => module as unknown));
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
   * Tool names whose schema accepts the driver's `session` label, read from
   * the driver's own manifest. The host injects the mission label only into
   * these calls, so unlabeled calls cannot outlive the named session. A
   * manifest that cannot be decoded is an error, not an empty set: the caller
   * falls back to its pinned list.
   */
  async sessionAwareToolNames(): Promise<ReadonlySet<string>> {
    const driver = await this.ensureStarted();
    const manifest = await driver.listToolsJson();
    const decoded = decodeDriverToolManifest(manifest);
    if (decoded._tag === "None")
      throw new CuaRuntimeUnavailableError("The driver tool manifest could not be decoded.");
    return new Set(
      decoded.value.tools.flatMap((tool) =>
        tool.inputSchema?.properties?.session === undefined ? [] : [tool.name],
      ),
    );
  }

  async metadata(): Promise<CuaRuntimeMetadata> {
    const driver = await this.ensureStarted();
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
    if (this.driver && this.driver.isAvailable()) return this.driver;
    if (this.starting) return this.starting;
    // One startup at a time, published before anything awaits: concurrent
    // callers share it. A driver that stopped being available still holds
    // its native session, so the startup releases it first and only one
    // driver ever lives.
    const stale = this.driver;
    this.driver = undefined;
    this.runState = "starting";
    this.failureReason = undefined;
    const start = (async () => {
      try {
        if (stale) await releaseDriver(stale);
        const module = (await this.load()) as CuaDriverModule;
        const driver = module.CuaDriver.create(undefined);
        this.driver = driver;
        this.runState = "ready";
        return driver;
      } catch (error) {
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
