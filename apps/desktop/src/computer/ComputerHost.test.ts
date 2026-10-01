// @effect-diagnostics nodeBuiltinImport:off - the test owns a real unix socket and temp dir.
// @effect-diagnostics globalTimers:off - socket round-trips need real timer deadlines.
// @effect-diagnostics globalDate:off - the same deadlines measure real elapsed time.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { COMPUTER_HOST_PROTOCOL_VERSION, type ComputerHostBootstrap } from "@circe/contracts";

import { ComputerHost, type ComputerHostOptions } from "./ComputerHost.ts";
import { CuaRuntime, type CuaRuntimeOptions } from "./CuaRuntime.ts";

interface FakeDriver {
  readonly calls: Array<{ name: string; args: unknown }>;
  failTool?: string;
  holdNext?: boolean;
  /** Hold this tool's call until releaseHeld runs; aborts reject. */
  holdTool?: string | undefined;
  releaseHeld?: () => void;
  shutdownCount: number;
  /** Tool manifest the driver advertises; absent means the manifest is unreadable. */
  manifest?: ReadonlyArray<{ name: string; properties: ReadonlyArray<string> }>;
  /** Scripted results by tool name. */
  results?: Record<string, (args: Record<string, unknown>) => Record<string, unknown>>;
}

const makeFakeRuntime = (driver: FakeDriver, catalog?: string): CuaRuntime =>
  new CuaRuntime({
    ...(catalog === undefined ? {} : { perceptionCatalog: catalog, environment: {} }),
    load: async () => ({
      CuaDriver: {
        create: () => ({
          isAvailable: () => true,
          listToolsJson: async () => {
            if (driver.manifest === undefined) throw new Error("no manifest");
            return JSON.stringify({
              tools: driver.manifest.map((tool) => ({
                name: tool.name,
                inputSchema: {
                  properties: Object.fromEntries(tool.properties.map((key) => [key, {}])),
                },
              })),
            });
          },
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
            const scripted = driver.results?.[name];
            if (scripted !== undefined) return scripted(args as Record<string, unknown>);
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
  extra: Partial<ComputerHostOptions> = {},
): Promise<void> => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-computer-test-"));
  const host = new ComputerHost({
    runtime: makeFakeRuntime(
      driver,
      extra.perception === undefined
        ? undefined
        : NodePath.join(extra.perception.stagingDirectory, "signed-catalog.json"),
    ),
    ...extra,
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

  it("guards field replacement with the active mission and fences it after stop", async () => {
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
      const request = {
        kind: "request",
        protocol: 1,
        method: "call",
        missionId: "mission-1",
        tool: "set_value",
        args: { pid: 7, window_id: 9, element_token: "s1:1", value: "50+3" },
      };
      client.send({ ...request, id: "c1" });
      expect((await client.next()).ok).toBe(true);
      expect(driver.calls.filter((call) => call.name === "set_value")).toHaveLength(1);
      client.send({
        kind: "request",
        protocol: 1,
        id: "s1",
        method: "stop",
        missionId: "mission-1",
      });
      await client.next();
      client.send({ ...request, id: "c2" });
      expect((await client.next()).result).toMatchObject({
        effect: "refused",
        refusalCode: "mission-ended",
      });
      expect(driver.calls.filter((call) => call.name === "set_value")).toHaveLength(1);
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

const PERCEPTION_MANIFEST = [
  { name: "get_window_state", properties: ["pid", "window_id", "session"] },
  { name: "click", properties: ["pid", "x", "y", "capture_id", "element_token", "session"] },
  { name: "parse_visual_regions", properties: ["capture_id", "options", "session"] },
  { name: "extension_status", properties: ["name"] },
  { name: "install_extension", properties: ["name", "confirm", "plan_sha256"] },
  { name: "check_permissions", properties: [] },
  { name: "start_session", properties: ["session"] },
  { name: "end_session", properties: ["session"] },
];

const structured = (value: unknown) => ({
  text: "ok",
  images: [],
  isError: false,
  degraded: false,
  structuredJson: JSON.stringify(value),
});

const status = (installed: boolean, healthy: boolean, version = "0.3.0") =>
  structured({ installed, healthy, active_version: installed ? version : null, detail: "d" });

/** A bundled catalog and its archive, served by a fake download. */
const perceptionFixture = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-perception-"));
  const archive = Buffer.from("perception archive bytes");
  const bundledCatalog = NodePath.join(directory, "signed-catalog.json");
  await NodeFSP.writeFile(
    bundledCatalog,
    JSON.stringify({
      payload: {
        version: "0.3.0",
        archive: "cua-perception-0.3.0.tar.gz",
        archive_size: archive.length,
        archive_sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
      },
      signature_algorithm: "ed25519",
      signature: "sig",
    }),
  );
  const downloads: string[] = [];
  return {
    downloads,
    options: {
      perception: {
        bundledCatalog,
        archiveUrl: "https://example.invalid/cua-perception-0.3.0.tar.gz",
        stagingDirectory: NodePath.join(directory, "staging"),
      },
      fetchArchive: async (url: string) => {
        downloads.push(url);
        return new Response(archive);
      },
    } satisfies Partial<ComputerHostOptions> & {
      fetchArchive: ComputerHostOptions["fetchArchive"];
    },
  };
};

describe("ComputerHost visual grounding", () => {
  const requestStatus = async (client: TestClient, bootstrap: ComputerHostBootstrap) => {
    // The driver runtime starts with a mission's first call.
    client.send(hello(bootstrap));
    client.send({
      kind: "request",
      protocol: 1,
      id: "b",
      method: "begin-mission",
      missionId: "m0",
    });
    await client.next();
    client.send({
      kind: "request",
      protocol: 1,
      id: "warm",
      method: "call",
      missionId: "m0",
      tool: "get_window_state",
      args: { pid: 1, window_id: 2 },
    });
    await client.next();
    client.send({ kind: "request", protocol: 1, id: "s", method: "status" });
    return (await client.next()).result as {
      capabilities: { nativeGrounding: boolean; visualGrounding: boolean };
      visualReason?: string;
    };
  };

  it("advertises visual grounding only with capture-bound clicks, parsing and a healthy extension", async () => {
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST,
      results: { extension_status: () => status(true, true) },
    };
    await withHost(driver, async ({ bootstrap, client }) => {
      const result = await requestStatus(client, bootstrap);
      expect(result.capabilities).toMatchObject({ nativeGrounding: true, visualGrounding: true });
    });
  });

  it("reports why visual grounding is off for a driver without capture-bound clicks", async () => {
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST.map((tool) =>
        tool.name === "click"
          ? { ...tool, properties: tool.properties.filter((key) => key !== "capture_id") }
          : tool,
      ),
      results: { extension_status: () => status(true, true) },
    };
    await withHost(driver, async ({ bootstrap, client }) => {
      const result = await requestStatus(client, bootstrap);
      expect(result.capabilities.visualGrounding).toBe(false);
      expect(result.visualReason).toMatch(/cannot parse and act on screen captures/);
    });
  });

  it("reports an absent extension without failing the host", async () => {
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST,
      results: { extension_status: () => status(false, false) },
    };
    await withHost(driver, async ({ bootstrap, client }) => {
      const result = await requestStatus(client, bootstrap);
      expect(result.capabilities).toMatchObject({ nativeGrounding: true, visualGrounding: false });
      expect(result.visualReason).toMatch(/not installed/);
    });
  });

  it("parses a capture under the mission's own session label", async () => {
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST,
      results: { extension_status: () => status(true, true) },
    };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b",
        method: "begin-mission",
        missionId: "m1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "p",
        method: "call",
        missionId: "m1",
        tool: "parse_visual_regions",
        args: { capture_id: "cap-1", session: "someone-else" },
      });
      await client.next();
      const parse = driver.calls.find((call) => call.name === "parse_visual_regions");
      expect(parse?.args).toEqual({ capture_id: "cap-1", session: "circe-m1" });
    });
  });

  it("passes a driver refusal code through to the caller", async () => {
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST,
      results: {
        click: () => ({
          text: "capture-bound click refused: capture expired",
          images: [],
          isError: true,
          errorCode: "capture_expired",
          degraded: false,
        }),
      },
    };
    await withHost(driver, async ({ bootstrap, client }) => {
      client.send(hello(bootstrap));
      client.send({
        kind: "request",
        protocol: 1,
        id: "b",
        method: "begin-mission",
        missionId: "m1",
      });
      await client.next();
      client.send({
        kind: "request",
        protocol: 1,
        id: "c",
        method: "call",
        missionId: "m1",
        tool: "click",
        args: { pid: 1, window_id: 2, x: 3, y: 4, capture_id: "cap-1" },
      });
      const reply = (await client.next()).result as Record<string, unknown>;
      expect(reply).toMatchObject({
        isError: true,
        effect: "refused",
        driverCode: "capture_expired",
      });
    });
  });

  it("retries a failed perception install after backoff instead of latching the failure", async () => {
    const fixture = await perceptionFixture();
    let attempts = 0;
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST,
      results: {
        extension_status: () => status(attempts > 1, attempts > 1),
        install_extension: (args) => {
          if (args.confirm === true && ++attempts === 1)
            return {
              text: "extension hook exceeded its execution limit",
              isError: true,
              degraded: false,
            };
          return structured({ plan_sha256: "a".repeat(64), version: "0.3.0", publisher_id: "p" });
        },
      },
    };
    await withHost(
      driver,
      async ({ bootstrap, client, host }) => {
        client.send(hello(bootstrap));
        client.send({
          kind: "request",
          protocol: 1,
          id: "begin",
          method: "begin-mission",
          missionId: "retry",
        });
        await client.next();
        client.send({
          kind: "request",
          protocol: 1,
          id: "read",
          method: "call",
          missionId: "retry",
          tool: "get_window_state",
          args: {},
        });
        await client.next();
        await until(() => attempts === 1);
        await host.status();
        expect(attempts).toBe(1);
        const realNow = Date.now.bind(Date);
        const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 60_000);
        try {
          await host.status();
          await until(() => attempts === 2);
          expect((await host.status()).capabilities.visualGrounding).toBe(true);
        } finally {
          clock.mockRestore();
        }
      },
      fixture.options,
    );
  });

  it("installs the bundled extension by confirming exactly the previewed plan", async () => {
    const fixture = await perceptionFixture();
    let installed = false;
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST,
      results: {
        extension_status: () => status(installed, installed),
        install_extension: (args) => {
          if (args.confirm === true) installed = args.plan_sha256 === "a".repeat(64);
          return structured({ plan_sha256: "a".repeat(64), version: "0.3.0", publisher_id: "p" });
        },
      },
    };
    await withHost(
      driver,
      async ({ bootstrap, client }) => {
        // Provisioning starts once a mission call brings the runtime up.
        client.send(hello(bootstrap));
        client.send({
          kind: "request",
          protocol: 1,
          id: "b",
          method: "begin-mission",
          missionId: "m0",
        });
        await client.next();
        client.send({
          kind: "request",
          protocol: 1,
          id: "c",
          method: "call",
          missionId: "m0",
          tool: "get_window_state",
          args: {},
        });
        await client.next();
        await until(() => installed);
        expect(fixture.downloads).toEqual(["https://example.invalid/cua-perception-0.3.0.tar.gz"]);
        const installs = driver.calls.filter((call) => call.name === "install_extension");
        expect(installs.map((call) => call.args)).toEqual([
          { name: "perception" },
          { name: "perception", confirm: true, plan_sha256: "a".repeat(64) },
        ]);
      },
      fixture.options,
    );
  });

  it("stops provisioning when the host closes mid-download", async () => {
    const fixture = await perceptionFixture();
    let releaseDownload: () => void = () => undefined;
    const downloadStarted = new Promise<void>((started) => {
      fixture.options.fetchArchive = async () => {
        started();
        await new Promise<void>((resolve) => {
          releaseDownload = resolve;
        });
        return new Response(Buffer.from("perception archive bytes"));
      };
    });
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST,
      results: {
        extension_status: () => status(false, false),
        install_extension: () => structured({ plan_sha256: "a".repeat(64), version: "0.3.0" }),
      },
    };
    await withHost(
      driver,
      async ({ bootstrap, client, host }) => {
        client.send(hello(bootstrap));
        client.send({
          kind: "request",
          protocol: 1,
          id: "b",
          method: "begin-mission",
          missionId: "m0",
        });
        await client.next();
        client.send({
          kind: "request",
          protocol: 1,
          id: "c",
          method: "call",
          missionId: "m0",
          tool: "get_window_state",
          args: {},
        });
        await client.next();
        await downloadStarted;
        await host.close();
        releaseDownload();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(driver.calls.some((call) => call.name === "install_extension")).toBe(false);
      },
      fixture.options,
    );
  });

  it("leaves a healthy install of the bundled version in place", async () => {
    const fixture = await perceptionFixture();
    const driver: FakeDriver = {
      calls: [],
      shutdownCount: 0,
      manifest: PERCEPTION_MANIFEST,
      results: {
        extension_status: () => status(true, true),
        install_extension: () => structured({ plan_sha256: "a".repeat(64), version: "0.3.0" }),
      },
    };
    await withHost(
      driver,
      async ({ bootstrap, client }) => {
        // Provisioning starts once a mission call brings the runtime up.
        client.send(hello(bootstrap));
        client.send({
          kind: "request",
          protocol: 1,
          id: "b",
          method: "begin-mission",
          missionId: "m0",
        });
        await client.next();
        client.send({
          kind: "request",
          protocol: 1,
          id: "c",
          method: "call",
          missionId: "m0",
          tool: "get_window_state",
          args: {},
        });
        await client.next();
        await until(() => driver.calls.some((call) => call.name === "extension_status"));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fixture.downloads).toEqual([]);
        expect(
          driver.calls.some(
            (call) =>
              call.name === "install_extension" &&
              (call.args as Record<string, unknown>).confirm === true,
          ),
        ).toBe(false);
      },
      fixture.options,
    );
  });
});
