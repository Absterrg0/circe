// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeConnectorServer } from "./ConnectorServer.ts";

const withServer = async <A>(
  use: (input: {
    readonly server: ReturnType<typeof makeConnectorServer>;
    readonly socketPath: string;
    readonly tokenPath: string;
  }) => Promise<A>,
): Promise<A> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-connector-"));
  const socketPath = NodePath.join(dir, "browser-connector.sock");
  const tokenPath = NodePath.join(dir, "browser-connector.token");
  const server = makeConnectorServer({ socketPath, tokenPath, requestTimeoutMs: 1_000 });
  await server.start();
  try {
    return await use({ server, socketPath, tokenPath });
  } finally {
    await server.stop();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

interface FakeHost {
  readonly socket: NodeNet.Socket;
  readonly requests: Array<Record<string, unknown>>;
  readonly respond: (response: Record<string, unknown>) => void;
  readonly handshake: (
    token: string,
    instanceId?: string,
    profileLabel?: string,
  ) => Promise<boolean>;
  readonly close: () => void;
}

const connectFakeHost = (socketPath: string): Promise<FakeHost> =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    const requests: Array<Record<string, unknown>> = [];
    const waiters: Array<(line: string) => void> = [];
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) {
          const waiter = waiters.shift();
          if (waiter !== undefined) {
            waiter(line);
          } else {
            requests.push(JSON.parse(line) as Record<string, unknown>);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        socket,
        requests,
        respond: (response) => socket.write(`${JSON.stringify(response)}\n`),
        handshake: (token, instanceId = "instance-one", profileLabel = "Chrome") =>
          new Promise<boolean>((resolveHandshake) => {
            waiters.push((line) => {
              const parsed = JSON.parse(line) as { ok?: boolean };
              resolveHandshake(parsed.ok === true);
            });
            socket.write(
              `${JSON.stringify({ type: "hello", token, extensionVersion: "0.1.0", instanceId, profileLabel })}\n`,
            );
          }),
        close: () => socket.destroy(),
      }),
    );
  });

const readToken = (tokenPath: string): string => NodeFS.readFileSync(tokenPath, "utf8").trim();

const waitForRequest = async (host: FakeHost): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const next = host.requests.shift();
    if (next !== undefined) return next;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The connector server sent no request.");
};

describe("browser connector server", () => {
  it("rejects a host with the wrong token", () =>
    withServer(async ({ socketPath, tokenPath, server }) => {
      const host = await connectFakeHost(socketPath);
      const accepted = await host.handshake("wrong-token");
      expect(accepted).toBe(false);
      expect(server.status()).toEqual({ connected: false });
      host.close();
      expect(readToken(tokenPath).length).toBeGreaterThan(0);
    }));

  it("correlates tab, snapshot, and action requests with one attached host", () =>
    withServer(async ({ socketPath, tokenPath, server }) => {
      const host = await connectFakeHost(socketPath);
      expect(await host.handshake(readToken(tokenPath))).toBe(true);
      expect(server.status()).toMatchObject({ connected: true, profileLabel: "Chrome" });

      const listPromise = server.listTabs();
      const listRequest = await waitForRequest(host);
      expect(listRequest.type).toBe("tab.list");
      host.respond({
        id: listRequest.id,
        type: "tab.list.result",
        tabs: [{ tabId: "7", title: "Inbox", url: "https://mail.example.com", active: true }],
      });
      expect(await listPromise).toEqual([
        { tabId: "7", title: "Inbox", url: "https://mail.example.com", active: true },
      ]);

      const attachPromise = server.attach({ tabId: "7" });
      const attachRequest = await waitForRequest(host);
      expect(attachRequest).toMatchObject({ type: "tab.attach", tabId: "7" });
      host.respond({
        id: attachRequest.id,
        type: "tab.attach.result",
        tabId: "7",
        profileLabel: "Chrome",
      });
      // The attach refreshes tab metadata with one follow-up list.
      const followUp = await waitForRequest(host);
      host.respond({
        id: followUp.id,
        type: "tab.list.result",
        tabs: [{ tabId: "7", title: "Inbox", url: "https://mail.example.com", active: true }],
      });
      expect(await attachPromise).toEqual({ tabId: "7", profileLabel: "Chrome" });
      expect(server.status()).toMatchObject({
        connected: true,
        attachedTabId: "7",
        attachedTabTitle: "Inbox",
      });

      const snapshotPromise = server.snapshot();
      const snapshotRequest = await waitForRequest(host);
      expect(snapshotRequest.type).toBe("snapshot");
      host.respond({
        id: snapshotRequest.id,
        type: "snapshot.result",
        snapshot: {
          tabId: "7",
          title: "Inbox",
          url: "https://mail.example.com",
          visibleText: "Compose",
          elements: [{ id: "ax:42", role: "button", name: "Compose", editable: false }],
        },
      });
      expect((await snapshotPromise).elements).toHaveLength(1);

      const applyPromise = server.apply({ operation: "press", key: "Enter" });
      const applyRequest = await waitForRequest(host);
      expect(applyRequest).toMatchObject({
        type: "action",
        action: { operation: "press", key: "Enter" },
      });
      host.respond({ id: applyRequest.id, type: "action.result", ok: true });
      expect(await applyPromise).toBe(true);
      host.close();
    }));

  it("fails a pending request when the connector disconnects", () =>
    withServer(async ({ socketPath, tokenPath, server }) => {
      const host = await connectFakeHost(socketPath);
      expect(await host.handshake(readToken(tokenPath))).toBe(true);
      const pending = server.snapshot();
      await waitForRequest(host);
      host.close();
      await expect(pending).rejects.toThrow(/connector/i);
      expect(server.status()).toEqual({ connected: false });
    }));
});
