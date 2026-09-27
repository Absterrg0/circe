// @effect-diagnostics nodeBuiltinImport:off - the live check owns a real unix socket and temp dir.
// @effect-diagnostics globalTimers:off - real driver actions need real timer deadlines.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { COMPUTER_HOST_PROTOCOL_VERSION, type ComputerHostBootstrap } from "@circe/contracts";
import { HostProcessPlatform } from "@circe/shared/hostProcess";

import { ComputerHost } from "./ComputerHost.ts";
import { CuaRuntime } from "./CuaRuntime.ts";

/**
 * Live acceptance against the real Cua runtime on a graphical session. Opt in
 * with CIRCE_COMPUTER_LIVE_TEST=1; the mutation leg additionally requires
 * CIRCE_COMPUTER_LIVE_MUTATION=1 because it launches and clicks a real app.
 * These checks cannot run on a headless CI box.
 */

const live = process.env.CIRCE_COMPUTER_LIVE_TEST === "1";
const mutation = process.env.CIRCE_COMPUTER_LIVE_MUTATION === "1";

interface Client {
  readonly socket: NodeNet.Socket;
  send: (message: unknown) => void;
  next: () => Promise<Record<string, unknown>>;
}

const connectClient = async (endpoint: string): Promise<Client> =>
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
            waiters.push((line) => resolveLine(JSON.parse(line) as Record<string, unknown>));
            setTimeout(() => rejectLine(new Error("Timed out waiting for a host frame")), 20_000);
          }),
      }),
    );
  });

describe.skipIf(!live)("ComputerHost live", () => {
  let directory = "";
  let host: ComputerHost;
  let bootstrap: ComputerHostBootstrap;
  let client: Client;
  let requestCounter = 0;

  const request = async (
    method: string,
    fields: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const id = `live-${++requestCounter}`;
    client.send({
      kind: "request",
      protocol: COMPUTER_HOST_PROTOCOL_VERSION,
      id,
      method,
      ...fields,
    });
    let frame = await client.next();
    while (frame.kind === "event") frame = await client.next();
    expect(frame.id).toBe(id);
    return frame;
  };

  const call = async (
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const reply = await request("call", { missionId: "live-mission", tool, args });
    expect(reply.ok).toBe(true);
    return reply.result as Record<string, unknown>;
  };

  beforeAll(async () => {
    directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-computer-live-"));
    host = new ComputerHost({
      runtime: new CuaRuntime({ requestTimeoutMs: 120_000 }),
      runtimeDirectory: directory,
    });
    bootstrap = await host.listen();
    client = await connectClient(bootstrap.endpoint);
    client.send({
      kind: "hello",
      protocol: COMPUTER_HOST_PROTOCOL_VERSION,
      capability: bootstrap.capability,
      pid: process.pid,
      platform: HostProcessPlatform.defaultValue() === "linux" ? "linux" : "other",
    });
    await request("begin-mission", { missionId: "live-mission" });
  });

  afterAll(async () => {
    client?.socket.destroy();
    await host?.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });

  it("reports a real driver and lists windows", async () => {
    const status = (await request("status")).result as {
      available: boolean;
      runtime: string;
      capabilities: Record<string, boolean>;
    };
    expect(status.available).toBe(true);

    const result = await call("list_windows", { on_screen_only: true });
    expect(result.isError).toBe(false);
    const structured = result.structured as { windows?: unknown[] } | undefined;
    expect(Array.isArray(structured?.windows)).toBe(true);
  });

  it.skipIf(!mutation)("launches Calculator and clicks an element", async () => {
    await call("launch_app", { name: "gnome-calculator" });

    let window: { pid: number; windowId: string; title: string } | undefined;
    for (let attempt = 0; attempt < 30 && !window; attempt += 1) {
      const windows = (await call("list_windows", { on_screen_only: true })).structured as {
        windows?: Array<{ pid: number; window_id: number | string; title: string }>;
      };
      const candidate = windows.windows?.find((item) => /calculator/i.test(item.title ?? ""));
      if (candidate) {
        window = {
          pid: candidate.pid,
          windowId: String(candidate.window_id),
          title: candidate.title,
        };
      } else {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    expect(window, "Calculator window never appeared").toBeDefined();

    const state = await call("get_window_state", {
      pid: window?.pid,
      window_id: Number(window?.windowId),
      include_screenshot: false,
    });
    const structured = state.structured as {
      elements?: Array<{ element_token?: string; label?: string; name?: string }>;
    };
    const five = (structured.elements ?? []).find((element) =>
      /^5$/.test(element.label ?? element.name ?? ""),
    );
    expect(five?.element_token, "Calculator digit 5 was not grounded").toBeDefined();

    const clicked = await call("click", {
      pid: window?.pid,
      window_id: Number(window?.windowId),
      element_token: five?.element_token,
    });
    expect(clicked.isError).toBe(false);

    const after = await call("get_window_state", {
      pid: window?.pid,
      window_id: Number(window?.windowId),
      include_screenshot: false,
    });
    expect(JSON.stringify(after.structured ?? after.text)).toContain("5");
  });
});
