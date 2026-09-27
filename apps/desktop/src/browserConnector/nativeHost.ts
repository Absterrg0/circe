// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { decodeNativeFrames, encodeNativeMessage } from "./nativeFraming.ts";

/**
 * Chrome native messaging host for the Circe browser connector.
 *
 * Chrome launches this process when the extension calls
 * `chrome.runtime.connectNative`. It authenticates to the local Circe node
 * with the token file the node owns and then relays frames both ways. It never
 * logs to stdout, because stdout is the native messaging channel.
 */

export const BROWSER_CONNECTOR_HOST_FLAG = "--circe-browser-connector-host";

export function isBrowserConnectorNativeHost(argv: ReadonlyArray<string>): boolean {
  return argv.includes(BROWSER_CONNECTOR_HOST_FLAG);
}

interface ConnectorPaths {
  readonly socketPath: string;
  readonly tokenPath: string;
}

const candidateStateDirs = (env: NodeJS.ProcessEnv): ReadonlyArray<string> => {
  const explicit = env.CIRCE_BROWSER_CONNECTOR_DIR?.trim();
  if (explicit !== undefined && explicit.length > 0) return [explicit];
  const home = env.CIRCE_HOME?.trim();
  const base =
    home !== undefined && home.length > 0 ? home : NodePath.join(NodeOS.homedir(), ".circe");
  return [NodePath.join(base, "userdata"), NodePath.join(base, "dev")];
};

export function resolveConnectorPaths(env: NodeJS.ProcessEnv = process.env): ConnectorPaths | null {
  for (const dir of candidateStateDirs(env)) {
    const tokenPath = NodePath.join(dir, "browser-connector.token");
    if (NodeFS.existsSync(tokenPath)) {
      const socketPath = NodePath.join(dir, "browser-connector.sock");
      return { socketPath, tokenPath };
    }
  }
  return null;
}

const writeFrame = (value: unknown) => {
  process.stdout.write(encodeNativeMessage(value));
};

const log = (message: string) => {
  process.stderr.write(`[circe-browser-connector] ${message}\n`);
};

interface ExtensionHello {
  readonly type: "hello";
  readonly extensionVersion?: string;
  readonly instanceId?: string;
  readonly profileLabel?: string;
}

const readFirstFrame = (): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeNativeFrames(buffer);
        if (decoded.messages.length === 0) return;
        process.stdin.off("data", onData);
        resolve(decoded.messages[0]);
      } catch (error) {
        process.stdin.off("data", onData);
        reject(error);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", () => reject(new Error("Chrome closed the native channel.")));
  });

export async function runBrowserConnectorNativeHost(): Promise<void> {
  // Chrome can close the channel at any time (extension reload, browser quit).
  // That is a normal shutdown, not an error to surface.
  let firstFrame: unknown;
  try {
    firstFrame = await readFirstFrame();
  } catch {
    return;
  }
  const first = firstFrame as ExtensionHello;
  if (first === null || typeof first !== "object" || first.type !== "hello") {
    writeFrame({ type: "error", message: "The connector must greet the host first." });
    return;
  }
  const paths = resolveConnectorPaths();
  if (paths === null) {
    writeFrame({
      type: "error",
      message: "Circe is not running on this machine, or its connector token is missing.",
    });
    return;
  }
  const token = NodeFS.readFileSync(paths.tokenPath, "utf8").trim();
  if (token.length === 0) {
    writeFrame({ type: "error", message: "The Circe connector token is empty." });
    return;
  }

  const socket = NodeNet.createConnection(paths.socketPath);
  socket.setEncoding("utf8");

  const helloResult = await new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      socket.off("data", onData);
      try {
        const parsed = JSON.parse(line) as { ok?: boolean; message?: string };
        resolve({
          ok: parsed.ok === true,
          ...(parsed.message === undefined ? {} : { message: parsed.message }),
        });
      } catch {
        reject(new Error("The Circe node sent a malformed handshake."));
      }
    };
    socket.once("error", reject);
    socket.on("data", onData);
    socket.write(
      `${JSON.stringify({
        type: "hello",
        token,
        extensionVersion: first.extensionVersion ?? "unknown",
        instanceId: first.instanceId ?? "chrome",
        profileLabel: first.profileLabel ?? "Chrome",
      })}\n`,
    );
  });

  if (!helloResult.ok) {
    writeFrame({
      type: "error",
      message: helloResult.message ?? "The Circe node refused the connector.",
    });
    socket.destroy();
    return;
  }
  writeFrame({ type: "hello.result", ok: true });

  let stdinBuffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    try {
      stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
      const decoded = decodeNativeFrames(stdinBuffer);
      stdinBuffer = Buffer.from(decoded.rest);
      for (const message of decoded.messages) {
        socket.write(`${JSON.stringify(message)}\n`);
      }
    } catch (error) {
      log(error instanceof Error ? error.message : "Failed to read from Chrome.");
      socket.destroy();
      process.exit(1);
    }
  });

  let socketBuffer = "";
  socket.on("data", (chunk: string) => {
    socketBuffer += chunk;
    let newline = socketBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = socketBuffer.slice(0, newline).trim();
      socketBuffer = socketBuffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          writeFrame(JSON.parse(line));
        } catch {
          log("The Circe node sent a malformed frame.");
        }
      }
      newline = socketBuffer.indexOf("\n");
    }
  });

  const shutdown = () => {
    socket.destroy();
    process.exit(0);
  };
  socket.on("close", shutdown);
  socket.on("error", (error) => {
    log(error.message);
    shutdown();
  });
  process.stdin.once("end", shutdown);
  process.stdin.resume();
}
