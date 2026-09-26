// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// The connector host is a local process launched by Chrome, so this listener
// stays on plain Node sockets and timers; the Effect layer wraps it.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  CirceBrowserConnectorHello,
  CirceBrowserConnectorHelloResult,
  CirceBrowserConnectorResponse,
  type CirceBrowserConnectorAction,
  type CirceBrowserConnectorSnapshot,
  type CirceBrowserConnectorStatus,
  type CirceBrowserConnectorTab,
} from "@circe/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Node-local listener for the Chrome extension's native messaging host. The
 * host authenticates with a token file the node owns (0600) over a socket the
 * node owns (0600), so only the local user can register a connector. One
 * connection is one extension instance with one visible profile label; the
 * node correlates one response to one request and never applies an unmatched
 * result.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const decodeHello = Schema.decodeUnknownOption(CirceBrowserConnectorHello);
const decodeResponse = Schema.decodeUnknownOption(CirceBrowserConnectorResponse);

/** One outbound request before the correlator assigns its id. */
type ConnectorRequestInput =
  | { readonly type: "tab.list" }
  | { readonly type: "tab.attach"; readonly tabId: string }
  | { readonly type: "tab.detach" }
  | { readonly type: "snapshot" }
  | { readonly type: "action"; readonly action: CirceBrowserConnectorAction };

export class CirceBrowserConnectorUnavailableError extends Error {
  constructor(message = "No browser connector is attached to this node.") {
    super(message);
    this.name = "CirceBrowserConnectorUnavailableError";
  }
}

export class CirceBrowserConnectorRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CirceBrowserConnectorRequestError";
  }
}

interface PendingRequest {
  readonly resolve: (response: CirceBrowserConnectorResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  readonly instanceId: string;
  readonly profileLabel: string;
  readonly socket: NodeNet.Socket;
  readonly pending: Map<string, PendingRequest>;
  attachedTabId: string | null;
  attachedTabTitle: string | null;
  attachedTabUrl: string | null;
  lastSeenAtMs: number;
}

export interface ConnectorServerOptions {
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
}

export interface ConnectorServer {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly status: (profileLabel?: string) => CirceBrowserConnectorStatus;
  readonly listTabs: (profileLabel?: string) => Promise<ReadonlyArray<CirceBrowserConnectorTab>>;
  readonly attach: (input: {
    readonly tabId: string;
    readonly profileLabel?: string;
  }) => Promise<{ readonly tabId: string; readonly profileLabel: string }>;
  readonly snapshot: (profileLabel?: string) => Promise<CirceBrowserConnectorSnapshot>;
  readonly apply: (action: CirceBrowserConnectorAction, profileLabel?: string) => Promise<boolean>;
}

export const makeConnectorServer = (options: ConnectorServerOptions): ConnectorServer => {
  const now = options.now ?? Date.now;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const connections = new Map<string, Connection>();
  let server: NodeNet.Server | null = null;
  let nextRequestId = 0;

  const isWindowsPipe = options.socketPath.startsWith("\\\\");
  const prepareSocketPath = async () => {
    if (isWindowsPipe) return;
    await NodeFS.promises.mkdir(NodePath.dirname(options.socketPath), {
      recursive: true,
      mode: 0o700,
    });
    await NodeFS.promises.unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  };

  const writeTokenFile = async () => {
    await NodeFS.promises.mkdir(NodePath.dirname(options.tokenPath), {
      recursive: true,
      mode: 0o700,
    });
    await NodeFS.promises.writeFile(options.tokenPath, `${token}\n`, { mode: 0o600 });
  };

  const selected = (profileLabel?: string): Connection | undefined => {
    const all = [...connections.values()];
    if (profileLabel !== undefined) {
      return all.find((connection) => connection.profileLabel === profileLabel);
    }
    const attached = all.find((connection) => connection.attachedTabId !== null);
    return attached ?? all[0];
  };

  const requireConnection = (profileLabel?: string): Connection => {
    const connection = selected(profileLabel);
    if (connection === undefined) throw new CirceBrowserConnectorUnavailableError();
    return connection;
  };

  const rejectPending = (connection: Connection, error: Error) => {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
  };

  const send = (
    connection: Connection,
    request: ConnectorRequestInput,
  ): Promise<CirceBrowserConnectorResponse> => {
    const id = `req-${(nextRequestId += 1)}`;
    const frame = JSON.stringify({ ...request, id });
    return new Promise<CirceBrowserConnectorResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(
          new CirceBrowserConnectorRequestError("The browser connector did not answer in time."),
        );
      }, requestTimeoutMs);
      connection.pending.set(id, { resolve, reject, timer });
      connection.socket.write(`${frame}\n`, (error) => {
        if (error === undefined || error === null) return;
        clearTimeout(timer);
        connection.pending.delete(id);
        reject(new CirceBrowserConnectorRequestError("The browser connector is unreachable."));
      });
    });
  };

  const handleFrame = (connection: Connection, line: string) => {
    connection.lastSeenAtMs = now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const response = decodeResponse(parsed);
    if (Option.isNone(response)) return;
    const pending = connection.pending.get(response.value.id ?? "");
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    connection.pending.delete(response.value.id ?? "");
    pending.resolve(response.value);
  };

  const handleConnection = (socket: NodeNet.Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let connection: Connection | null = null;

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          if (connection === null) {
            let parsedHello: unknown;
            try {
              parsedHello = JSON.parse(line);
            } catch {
              socket.destroy();
              return;
            }
            const hello = decodeHello(parsedHello);
            if (Option.isNone(hello) || hello.value.token !== token) {
              const refusal: CirceBrowserConnectorHelloResult = {
                type: "hello.result",
                ok: false,
                message: "The browser connector token was rejected.",
              };
              socket.end(`${JSON.stringify(refusal)}\n`);
              return;
            }
            connection = {
              instanceId: hello.value.instanceId,
              profileLabel: hello.value.profileLabel,
              socket,
              pending: new Map(),
              attachedTabId: null,
              attachedTabTitle: null,
              attachedTabUrl: null,
              lastSeenAtMs: now(),
            };
            const previous = connections.get(connection.instanceId);
            if (previous !== undefined && previous !== connection) {
              rejectPending(previous, new CirceBrowserConnectorUnavailableError());
              previous.socket.destroy();
            }
            connections.set(connection.instanceId, connection);
            const accepted: CirceBrowserConnectorHelloResult = {
              type: "hello.result",
              ok: true,
            };
            socket.write(`${JSON.stringify(accepted)}\n`);
          } else {
            handleFrame(connection, line);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });

    const close = () => {
      if (connection === null) return;
      connections.delete(connection.instanceId);
      rejectPending(connection, new CirceBrowserConnectorUnavailableError());
    };
    socket.on("close", close);
    socket.on("error", close);
  };

  const start = async () => {
    await prepareSocketPath();
    await writeTokenFile();
    server = NodeNet.createServer(handleConnection);
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(options.socketPath, () => {
        server!.off("error", reject);
        resolve();
      });
    });
    if (!isWindowsPipe) {
      await NodeFS.promises.chmod(options.socketPath, 0o600).catch(() => undefined);
    }
  };

  const stop = async () => {
    for (const connection of connections.values()) {
      rejectPending(connection, new CirceBrowserConnectorUnavailableError());
      connection.socket.destroy();
    }
    connections.clear();
    const current = server;
    server = null;
    if (current !== null) {
      await new Promise<void>((resolve) => current.close(() => resolve()));
    }
    if (!isWindowsPipe) {
      await NodeFS.promises.unlink(options.socketPath).catch(() => undefined);
    }
    await NodeFS.promises.unlink(options.tokenPath).catch(() => undefined);
  };

  const status = (profileLabel?: string): CirceBrowserConnectorStatus => {
    const connection = selected(profileLabel);
    if (connection === undefined) return { connected: false };
    return {
      connected: true,
      instanceId: connection.instanceId,
      profileLabel: connection.profileLabel,
      ...(connection.attachedTabId === null
        ? {}
        : {
            attachedTabId: connection.attachedTabId,
            ...(connection.attachedTabTitle === null
              ? {}
              : { attachedTabTitle: connection.attachedTabTitle }),
            ...(connection.attachedTabUrl === null
              ? {}
              : { attachedTabUrl: connection.attachedTabUrl }),
          }),
      lastSeenAtMs: connection.lastSeenAtMs,
    };
  };

  const listTabs = async (profileLabel?: string) => {
    const connection = requireConnection(profileLabel);
    const response = await send(connection, { type: "tab.list" });
    if (response.type !== "tab.list.result") {
      throw new CirceBrowserConnectorRequestError(
        response.type === "error"
          ? response.message
          : "The browser connector returned an unexpected result.",
      );
    }
    return response.tabs;
  };

  const attach = async (input: { readonly tabId: string; readonly profileLabel?: string }) => {
    const connection = requireConnection(input.profileLabel);
    const response = await send(connection, { type: "tab.attach", tabId: input.tabId });
    if (response.type !== "tab.attach.result") {
      throw new CirceBrowserConnectorRequestError(
        response.type === "error"
          ? response.message
          : "The browser connector could not attach to that tab.",
      );
    }
    const tabs = await listTabs(input.profileLabel).catch(() => []);
    const tab = tabs.find((candidate) => candidate.tabId === response.tabId);
    connection.attachedTabId = response.tabId;
    connection.attachedTabTitle = tab?.title ?? null;
    connection.attachedTabUrl = tab?.url ?? null;
    return { tabId: response.tabId, profileLabel: response.profileLabel };
  };

  const snapshot = async (profileLabel?: string) => {
    const connection = requireConnection(profileLabel);
    const response = await send(connection, { type: "snapshot" });
    if (response.type !== "snapshot.result") {
      throw new CirceBrowserConnectorRequestError(
        response.type === "error"
          ? response.message
          : "The browser connector returned no page state.",
      );
    }
    connection.attachedTabUrl = response.snapshot.url;
    connection.attachedTabTitle = response.snapshot.title;
    return response.snapshot;
  };

  const apply = async (action: CirceBrowserConnectorAction, profileLabel?: string) => {
    const connection = requireConnection(profileLabel);
    const response = await send(connection, { type: "action", action });
    if (response.type !== "action.result") {
      throw new CirceBrowserConnectorRequestError(
        response.type === "error" ? response.message : "The browser connector refused that action.",
      );
    }
    return response.ok;
  };

  return { start, stop, status, listTabs, attach, snapshot, apply };
};
