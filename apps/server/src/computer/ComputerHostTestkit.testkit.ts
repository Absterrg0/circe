// @effect-diagnostics nodeBuiltinImport:off - the fake host owns a real unix socket path and
// temp directory; it stands in for the Electron host, which is not Effect code.
// @effect-diagnostics globalTimers:off - the delayed begin reply is a raw socket test hook.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  COMPUTER_HOST_PROTOCOL_VERSION,
  type ComputerHostBootstrap,
  type ComputerHostToolResult,
} from "@circe/contracts";

/**
 * A minimal stand-in for the desktop host for server-side tests. It validates
 * the hello capability, answers requests from a per-tool table, and can push
 * unsolicited events, which is enough to exercise transport, policy, audit,
 * and mission teardown without Electron or the Cua runtime.
 */

interface FakeRequest {
  readonly id: string;
  readonly method: string;
  readonly missionId?: string;
  readonly tool?: string;
}

export interface FakeHostServer {
  readonly bootstrap: ComputerHostBootstrap;
  readonly requests: FakeRequest[];
  readonly hellos: Array<Record<string, unknown>>;
  setToolResult: (tool: string, result: ComputerHostToolResult) => void;
  /** Delay begin-mission replies so concurrent starts can race in tests. */
  setBeginDelay: (ms: number) => void;
  /** Answer begin-mission with a mission-conflict error. */
  setBeginConflict: (conflict: boolean) => void;
  pushEvent: (event: { event: string; missionId?: string }) => void;
  dropConnection: () => void;
  close: () => Promise<void>;
}

const okResult = (structured?: unknown): ComputerHostToolResult => ({
  isError: false,
  degraded: false,
  effect: "verified",
  text: "ok",
  ...(structured !== undefined ? { structured } : {}),
  images: [],
});

export const startFakeHost = async (): Promise<FakeHostServer> => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-fake-host-"));
  const endpoint = NodePath.join(directory, "host.sock");
  const capability = "c".repeat(64);
  const requests: FakeRequest[] = [];
  const hellos: Array<Record<string, unknown>> = [];
  const toolResults = new Map<string, ComputerHostToolResult>();
  let socket: NodeNet.Socket | undefined;
  let beginDelayMs = 0;
  let beginConflict = false;

  const server: NodeNet.Server = NodeNet.createServer((accepted) => {
    socket?.destroy();
    socket = accepted;
    accepted.setEncoding("utf8");
    let buffer = "";
    let greeted = false;
    accepted.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.kind === "hello") {
          if (message.capability !== capability) {
            accepted.destroy();
            return;
          }
          greeted = true;
          hellos.push(message);
          continue;
        }
        if (!greeted) {
          accepted.destroy();
          return;
        }
        const request: FakeRequest = {
          id: String(message.id),
          method: String(message.method),
          ...(typeof message.missionId === "string" ? { missionId: message.missionId } : {}),
          ...(typeof message.tool === "string" ? { tool: message.tool } : {}),
        };
        requests.push(request);
        const reply = (result: unknown): void => {
          accepted.write(
            `${JSON.stringify({ kind: "reply", id: request.id, ok: true, result })}\n`,
          );
        };
        if (request.method === "begin-mission") {
          const replyBegin = (): void => {
            if (beginConflict) {
              accepted.write(
                `${JSON.stringify({
                  kind: "reply",
                  id: request.id,
                  ok: false,
                  error: {
                    code: "mission-conflict",
                    message: "Another computer mission is already active.",
                  },
                })}\n`,
              );
              return;
            }
            reply({ active: true });
          };
          if (beginDelayMs > 0) setTimeout(replyBegin, beginDelayMs);
          else replyBegin();
          continue;
        }
        if (request.method === "stop") {
          reply({ stopped: true, settled: true, closed: true });
          continue;
        }
        if (request.method === "end-mission") {
          reply({ ended: true, settled: true, closed: true });
          continue;
        }
        if (request.method === "status") {
          reply({
            available: true,
            platform: "linux",
            runtime: "ready",
            capabilities: {
              observe: true,
              capture: true,
              pointer: true,
              keyboard: true,
              windows: true,
              browser: false,
            },
          });
          continue;
        }
        if (request.method === "call" && request.tool) {
          reply(toolResults.get(request.tool) ?? okResult());
          continue;
        }
        reply({ ok: true });
      }
    });
    accepted.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(endpoint, resolve));

  return {
    bootstrap: { endpoint, capability, pid: 1234 },
    requests,
    hellos,
    setToolResult: (tool, result) => {
      toolResults.set(tool, result);
    },
    setBeginDelay: (ms) => {
      beginDelayMs = ms;
    },
    setBeginConflict: (conflict) => {
      beginConflict = conflict;
    },
    pushEvent: (event) => {
      socket?.write(
        `${JSON.stringify({
          kind: "event",
          protocol: COMPUTER_HOST_PROTOCOL_VERSION,
          ...event,
        })}\n`,
      );
    },
    dropConnection: () => {
      socket?.destroy();
      socket = undefined;
    },
    close: async () => {
      socket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
};
