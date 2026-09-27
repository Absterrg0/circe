// @effect-diagnostics nodeBuiltinImport:off - the test owns a real unix socket and temp dir.
// @effect-diagnostics globalTimers:off - socket round-trips need real timer deadlines.
// @effect-diagnostics globalDate:off - the same deadlines measure real elapsed time.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { COMPUTER_HOST_PROTOCOL_VERSION, type ComputerHostBootstrap } from "@circe/contracts";

import { ComputerHost } from "./ComputerHost.ts";
import { CuaRuntime, type CuaRuntimeOptions } from "./CuaRuntime.ts";

interface FakeDriver {
  readonly calls: Array<{ name: string; args: unknown }>;
  failTool?: string;
  holdNext?: boolean;
  /** Hold this tool's call until releaseHeld runs; aborts reject. */
  holdTool?: string | undefined;
  releaseHeld?: () => void;
  shutdownCount: number;
}

const makeFakeRuntime = (driver: FakeDriver): CuaRuntime =>
  new CuaRuntime({
    load: async () => ({
      CuaDriver: {
        create: () => ({
          isAvailable: () => true,
          metadata: async () => ({
            driverVersion: "0.0.0-test",
            contractVersion: "1",
            pid: 4242,
            embedded: true,
          }),
          callTool: async (
            name: string,
            argsJson: string,
            options?: { readonly signal?: AbortSignal },
          ) => {
            const args = JSON.parse(argsJson) as unknown;
            driver.calls.push({ name, args });
            if (driver.failTool === name) {
              throw new Error(`${name} failed`);
            }
            if (name === "click" && driver.holdNext) {
              driver.holdNext = false;
              return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              });
            }
            if (driver.holdTool === name) {
              driver.holdTool = undefined;
              return new Promise((resolve, reject) => {
                driver.releaseHeld = () =>
                  resolve({
                    text: `${name} released`,
                    images: [],
                    isError: false,
                    degraded: false,
                  });
                options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              });
            }
            if (name === "list_windows") {
              return {
                text: "windows",
                images: [{ mimeType: "image/png", dataBase64: "AAAA" }],
                structuredJson: JSON.stringify({ windows: [], effect: "verified" }),
                isError: false,
                degraded: false,
              };
            }
            if (name === "click") {
              return {
                text: "clicked",
                images: [],
                structuredJson: JSON.stringify({
                  effect: "verified",
                  pid: 7,
                  window_id: 9,
                }),
                isError: false,
                degraded: false,
              };
            }
            return { text: name, images: [], isError: false, degraded: false };
          },
          shutdown: async () => {
            driver.shutdownCount += 1;
          },
          uniffiDestroy: () => {},
        }),
      },
    }),
  } satisfies CuaRuntimeOptions);

interface TestClient {
  readonly socket: NodeNet.Socket;
  send: (message: unknown) => void;
  next: () => Promise<Record<string, unknown>>;
}

const connectClient = async (endpoint: string): Promise<TestClient> =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.connect(endpoint);
    let buffer = "";
    const queue: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else queue.push(line);
      }
    });
    socket.on("error", reject);
    socket.once("connect", () =>
      resolve({
        socket,
        send: (message) => socket.write(`${JSON.stringify(message)}\n`),
        next: () =>
          new Promise((resolveLine, rejectLine) => {
            const queued = queue.shift();
            if (queued !== undefined) {
              resolveLine(JSON.parse(queued) as Record<string, unknown>);
              return;
            }
            const timer = setTimeout(
              () => rejectLine(new Error("Timed out waiting for a frame")),
              5_000,
            );
            waiters.push((line) => {
              clearTimeout(timer);
              resolveLine(JSON.parse(line) as Record<string, unknown>);
            });
          }),
      }),
    );
  });

const until = async (check: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("Condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const withHost = async (
  driver: FakeDriver,
  run: (context: {
    bootstrap: ComputerHostBootstrap;
    host: ComputerHost;
    client: TestClient;
  }) => Promise<void>,
): Promise<void> => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-computer-test-"));
  const host = new ComputerHost({
    runtime: makeFakeRuntime(driver),
    runtimeDirectory: directory,
    platform: "linux",
    environment: { DISPLAY: ":0" },
  });
  const bootstrap = await host.listen();
  const client = await connectClient(bootstrap.endpoint);
  try {
    await run({ bootstrap, host, client });
  } finally {
    client.socket.destroy();
    await host.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
};

const hello = (bootstrap: ComputerHostBootstrap) => ({
  kind: "hello",
  protocol: COMPUTER_HOST_PROTOCOL_VERSION,
  capability: bootstrap.capability,
  pid: process.pid,
  platform: "linux",
});

describe("ComputerHost", () => {
  it("rejects a hello with the wrong capability", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0 };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send({ ...hello(bootstrap), capability: "0".repeat(64) });
      await new Promise((resolve) => client.socket.once("close", resolve));
      expect(driver.calls).toHaveLength(0);
    });
  });

  it("reports status and runs a read call for an active mission", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0 };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({ kind: "request", protocol: 1, id: "s1", method: "status" });
      const status = await client.next();
      expect(status.ok).toBe(true);
      expect((status.result as { available: boolean }).available).toBe(true);

      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();

      client.send({
        kind: "request",
        protocol: 1,
        id: "c1",
        method: "call",
        missionId: "mission-1",
        tool: "list_windows",
        args: {},
      });
      const reply = await client.next();
      const result = reply.result as {
        effect: string;
        images: unknown[];
        structured: { windows: unknown[] };
      };
      expect(reply.ok).toBe(true);
      expect(result.effect).toBe("verified");
      expect(result.images).toHaveLength(1);
      expect(result.structured.windows).toEqual([]);
      expect(driver.calls.map((call) => call.name)).toEqual(["start_session", "list_windows"]);
    });
  });

  it("refuses calls without a mission and unknown tools", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0 };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "c1",
        method: "call",
        missionId: "missing",
        tool: "list_windows",
      });
      const noMission = (await client.next()).result as { effect: string; refusalCode: string };
      expect(noMission).toMatchObject({ effect: "refused", refusalCode: "mission-ended" });

      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "c2",
        method: "call",
        missionId: "mission-1",
        tool: "exec_shell",
      });
      const unknownTool = (await client.next()).result as { effect: string; refusalCode: string };
      expect(unknownTool).toMatchObject({ effect: "refused", refusalCode: "tool-not-allowed" });
    });
  });

  it("revokes queued work on stop and never lets a queued read reopen it", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0, holdNext: true };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();

      // Queue a read and a mutation behind the held click, all before Stop.
      client.send({
        kind: "request",
        protocol: 1,
        id: "c1",
        method: "call",
        missionId: "mission-1",
        tool: "click",
        args: { x: 1, y: 1 },
      });
      await until(() => driver.calls.some((call) => call.name === "click"));
      client.send({
        kind: "request",
        protocol: 1,
        id: "c2",
        method: "call",
        missionId: "mission-1",
        tool: "list_windows",
        args: {},
      });
      client.send({
        kind: "request",
        protocol: 1,
        id: "c3",
        method: "call",
        missionId: "mission-1",
        tool: "click",
        args: { x: 2, y: 2 },
      });
      client.send({
        kind: "request",
        protocol: 1,
        id: "s1",
        method: "stop",
        missionId: "mission-1",
      });

      // The stop acknowledgement races the aborted call and the fenced queue,
      // so collect replies by id rather than by arrival order.
      const replies = new Map<string, Record<string, unknown>>();
      while (replies.size < 4) {
        const frame = await client.next();
        replies.set(String(frame.id), frame.result as Record<string, unknown>);
      }
      expect(replies.get("s1")).toMatchObject({ stopped: true, settled: true });
      expect(replies.get("c1")).toMatchObject({
        effect: "dispatched-unknown",
        refusalCode: "input-interrupted",
      });
      expect(replies.get("c2")).toMatchObject({ effect: "refused", refusalCode: "mission-ended" });
      expect(replies.get("c3")).toMatchObject({ effect: "refused", refusalCode: "mission-ended" });

      // Only the first click was dispatched, and Stop closed the session it
      // revoked rather than leaving it open in the driver.
      expect(driver.calls.filter((call) => call.name === "click")).toHaveLength(1);
      const end = driver.calls.find((call) => call.name === "end_session");
      expect(end?.args).toMatchObject({ session: "circe-mission-1" });
    });
  });

  it("never dispatches a queued mutation after its caller's deadline", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0, holdTool: "list_windows" };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();

      // Hold the first read, then queue a click with a short deadline.
      client.send({
        kind: "request",
        protocol: 1,
        id: "c1",
        method: "call",
        missionId: "mission-1",
        tool: "list_windows",
        args: {},
      });
      await until(() => driver.holdTool === undefined);
      client.send({
        kind: "request",
        protocol: 1,
        id: "c2",
        method: "call",
        missionId: "mission-1",
        tool: "click",
        args: { pid: 1, window_id: 2, x: 3, y: 4 },
        timeoutMs: 20,
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      driver.releaseHeld?.();
      const readReply = (await client.next()).result as { effect: string };
      expect(readReply.effect).toBe("verified");
      const clickReply = (await client.next()).result as { refusalCode: string };
      expect(clickReply.refusalCode).toBe("timeout");
      expect(driver.calls.some((call) => call.name === "click")).toBe(false);
    });
  });

  it("binds every session-aware call to the named mission session", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0 };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "c1",
        method: "call",
        missionId: "mission-1",
        tool: "click",
        args: { pid: 7, window_id: 9, x: 1, y: 1 },
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "e1",
        method: "end-mission",
        missionId: "mission-1",
      });
      await client.next();

      const start = driver.calls.find((call) => call.name === "start_session");
      expect(start?.args).toMatchObject({ session: "circe-mission-1" });
      const click = driver.calls.find((call) => call.name === "click");
      expect(click?.args).toMatchObject({ session: "circe-mission-1" });
      const end = driver.calls.find((call) => call.name === "end_session");
      expect(end?.args).toMatchObject({ session: "circe-mission-1" });
    });
  });

  it("refuses a second mission while one is active", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0 };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "b2",
        method: "begin-mission",
        missionId: "mission-2",
      });
      const reply = await client.next();
      expect(reply.ok).toBe(false);
      expect((reply.error as { code: string }).code).toBe("mission-conflict");
    });
  });

  it("revokes missions and queued work when the server disconnects", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0 };
    await withHost(driver, async ({ bootstrap, host, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "c1",
        method: "call",
        missionId: "mission-1",
        tool: "list_windows",
        args: {},
      });
      await client.next();

      client.socket.destroy();
      await until(() => driver.calls.some((call) => call.name === "end_session"));
      const end = driver.calls.find((call) => call.name === "end_session");
      expect(end?.args).toMatchObject({ session: "circe-mission-1" });

      // A reconnected server sees no mission from the revoked generation.
      const reconnected = await connectClient(bootstrap.endpoint);
      try {
        reconnected.send(hello(bootstrap));
        reconnected.send({
          kind: "request",
          protocol: 1,
          id: "c2",
          method: "call",
          missionId: "mission-1",
          tool: "list_windows",
          args: {},
        });
        const reply = (await reconnected.next()).result as { refusalCode: string };
        expect(reply.refusalCode).toBe("mission-ended");
      } finally {
        reconnected.socket.destroy();
        await host.close();
      }
    });
  });

  it("ends a mission and refuses later calls", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0 };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "e1",
        method: "end-mission",
        missionId: "mission-1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "c1",
        method: "call",
        missionId: "mission-1",
        tool: "list_windows",
      });
      const reply = (await client.next()).result as { effect: string; refusalCode: string };
      expect(reply).toMatchObject({ effect: "refused", refusalCode: "mission-ended" });
    });
  });

  it("reports driver failures without claiming not-dispatched for mutations", async () => {
    const driver: FakeDriver = { calls: [], shutdownCount: 0, failTool: "click" };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b1",
        method: "begin-mission",
        missionId: "mission-1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "c1",
        method: "call",
        missionId: "mission-1",
        tool: "click",
        args: { x: 1, y: 1 },
      });
      const reply = (await client.next()).result as { effect: string; isError: boolean };
      expect(reply.isError).toBe(true);
      expect(reply.effect).toBe("dispatched-unknown");
    });
  });
});
