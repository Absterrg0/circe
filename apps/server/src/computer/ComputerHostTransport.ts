// @effect-diagnostics globalTimers:off - reconnect backoff and request deadlines are transport
// deadlines on a node socket; they must elapse even while the consumer fiber is busy.
// @effect-diagnostics preferSchemaOverJson:off - the host wire format is newline-delimited JSON
// validated by schema on decode; the outbound side writes plain records.
import * as NodeNet from "node:net";

import {
  COMPUTER_HOST_PROTOCOL_VERSION,
  ComputerHostEvent,
  ComputerHostHello,
  ComputerHostReply,
  type ComputerHostBootstrap,
  type ComputerHostToolResult,
} from "@circe/contracts";
import * as Schema from "effect/Schema";

/**
 * One persistent connection to the desktop computer host. The transport owns
 * framing, correlation, reconnect, and nothing else: policy, missions, and
 * audit live in ComputerService. Requests are rejected while disconnected
 * instead of being queued, because a delayed mutation must not run after the
 * user's intent has moved on.
 */

const REQUEST_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;

export type ComputerHostTransportState = "connecting" | "connected" | "disconnected" | "stopped";

export type ComputerHostTransportErrorCode =
  | "driver-unavailable"
  | "timeout"
  | "protocol-error"
  | "host-error";

export class ComputerHostTransportError extends Error {
  readonly code: ComputerHostTransportErrorCode;

  constructor(code: ComputerHostTransportErrorCode, message: string) {
    super(message);
    this.name = "ComputerHostTransportError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly resolve: (reply: ComputerHostReply) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export interface ComputerHostTransportOptions {
  readonly bootstrap: ComputerHostBootstrap;
  readonly platform: "darwin" | "linux" | "win32" | "other";
  readonly appVersion?: string;
  readonly onEvent?: (event: ComputerHostEvent) => void;
  readonly onStateChange?: (state: ComputerHostTransportState) => void;
}

const decodeReply = Schema.decodeUnknownOption(ComputerHostReply);
const decodeEvent = Schema.decodeUnknownOption(ComputerHostEvent);

export class ComputerHostTransport {
  private socket: NodeNet.Socket | undefined;
  private buffer = "";
  private state: ComputerHostTransportState = "stopped";
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private counter = 0;
  private readonly options: ComputerHostTransportOptions;

  constructor(options: ComputerHostTransportOptions) {
    this.options = options;
  }

  get connectionState(): ComputerHostTransportState {
    return this.state;
  }

  get connected(): boolean {
    return this.state === "connected";
  }

  start(): void {
    if (this.stopped || this.socket) return;
    this.setState("connecting");
    const socket = NodeNet.createConnection(this.options.bootstrap.endpoint);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.on("connect", () => {
      this.buffer = "";
      this.reconnectAttempt = 0;
      const hello: ComputerHostHello = {
        kind: "hello",
        protocol: COMPUTER_HOST_PROTOCOL_VERSION,
        capability: this.options.bootstrap.capability,
        pid: this.options.bootstrap.pid,
        platform: this.options.platform,
        ...(this.options.appVersion ? { appVersion: this.options.appVersion } : {}),
      };
      socket.write(`${JSON.stringify(hello)}\n`);
      this.setState("connected");
    });
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.handleClose(socket));
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ComputerHostTransportError("host-error", "Transport stopped."));
      this.pending.delete(id);
    }
    this.socket?.destroy();
    this.socket = undefined;
    this.setState("stopped");
  }

  async request(
    method: "status" | "begin-mission" | "call" | "stop" | "end-mission",
    fields: {
      readonly missionId?: string;
      readonly tool?: string;
      readonly args?: unknown;
      readonly reason?: string;
    } = {},
    options: { readonly timeoutMs?: number } = {},
  ): Promise<ComputerHostReply> {
    if (!this.connected || !this.socket || this.socket.destroyed)
      throw new ComputerHostTransportError(
        "driver-unavailable",
        "The desktop computer host is not connected.",
      );
    const id = `r${++this.counter}`;
    const timeoutMs =
      options.timeoutMs ?? (method === "stop" ? STOP_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    const reply = new Promise<ComputerHostReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ComputerHostTransportError(
            "timeout",
            `The desktop computer host did not answer ${method} within ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.socket.write(
      `${JSON.stringify({
        kind: "request",
        protocol: COMPUTER_HOST_PROTOCOL_VERSION,
        id,
        method,
        timeoutMs,
        ...(fields.missionId ? { missionId: fields.missionId } : {}),
        ...(fields.tool ? { tool: fields.tool } : {}),
        ...(fields.args !== undefined ? { args: fields.args } : {}),
        ...(fields.reason ? { reason: fields.reason } : {}),
      })}\n`,
    );
    return reply;
  }

  async callTool(input: {
    readonly missionId: string;
    readonly tool: string;
    readonly args?: unknown;
    readonly timeoutMs?: number;
  }): Promise<ComputerHostToolResult> {
    const reply = await this.request(
      "call",
      { missionId: input.missionId, tool: input.tool, args: input.args },
      input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {},
    );
    if (!reply.ok) {
      throw new ComputerHostTransportError(
        "host-error",
        reply.error?.message ?? "The desktop computer host rejected the call.",
      );
    }
    const result = reply.result as ComputerHostToolResult | undefined;
    if (!result || typeof result !== "object" || typeof result.effect !== "string")
      throw new ComputerHostTransportError(
        "protocol-error",
        "The desktop computer host returned a malformed tool result.",
      );
    return result;
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const event = decodeEvent(value);
      if (event._tag === "Some") {
        this.options.onEvent?.(event.value);
        continue;
      }
      const reply = decodeReply(value);
      if (reply._tag === "None") continue;
      const pending = this.pending.get(reply.value.id);
      if (!pending) continue;
      this.pending.delete(reply.value.id);
      clearTimeout(pending.timer);
      pending.resolve(reply.value);
    }
  }

  private handleClose(socket: NodeNet.Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    if (this.stopped) return;
    this.setState("disconnected");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new ComputerHostTransportError(
          "driver-unavailable",
          "The computer host connection closed.",
        ),
      );
      this.pending.delete(id);
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.start();
    }, delay);
  }

  private setState(state: ComputerHostTransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
