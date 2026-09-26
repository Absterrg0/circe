// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { CirceBotId } from "@circe/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  GrokBotGatewayError,
  grokBotPrompt,
  loopbackGatewayHost,
  makeGrokBotGateway,
  readGrokBotConnection,
  resolveGrokBotDiscoveryPath,
} from "./grokBotGateway.ts";
import { isLoopbackAddress } from "./botReplyRoute.ts";

const directories: string[] = [];

function discoveryFile(contents: unknown): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-grok-"));
  directories.push(directory);
  const path = NodePath.join(directory, "gateway.json");
  NodeFS.writeFileSync(path, JSON.stringify(contents));
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Grok Bot gateway discovery", () => {
  it("prefers the configured path and falls back to the app default only when it exists", async () => {
    const exists = async (path: string) => path === "/home/me/agent-data/gateway.json";
    await expect(
      resolveGrokBotDiscoveryPath({
        env: { CIRCE_GROK_GATEWAY: " /srv/gw.json " },
        homeDir: "/home/me",
        exists,
      }),
    ).resolves.toBe("/srv/gw.json");
    await expect(
      resolveGrokBotDiscoveryPath({ env: {}, homeDir: "/home/me", exists }),
    ).resolves.toBe("/home/me/agent-data/gateway.json");
    await expect(
      resolveGrokBotDiscoveryPath({ env: {}, homeDir: "/home/other", exists }),
    ).resolves.toBeNull();
  });

  it("maps wildcard hosts to loopback and refuses remote hosts", () => {
    expect(loopbackGatewayHost(undefined)).toBe("127.0.0.1");
    expect(loopbackGatewayHost("0.0.0.0")).toBe("127.0.0.1");
    expect(loopbackGatewayHost("localhost")).toBe("127.0.0.1");
    expect(loopbackGatewayHost("::")).toBe("[::1]");
    expect(loopbackGatewayHost("127.0.0.9")).toBe("127.0.0.9");
    expect(loopbackGatewayHost("100.101.102.103")).toBeNull();
    expect(loopbackGatewayHost("example.com")).toBeNull();
  });

  it("rejects a discovery file that points off this computer", async () => {
    const path = discoveryFile({ port: 4000, host: "10.0.0.2" });
    await expect(readGrokBotConnection(path)).rejects.toMatchObject({
      failure: "not-loopback",
    });
    await expect(readGrokBotConnection("/nonexistent/gateway.json")).rejects.toBeInstanceOf(
      GrokBotGatewayError,
    );
  });
});

describe("Grok Bot gateway calls", () => {
  it("lists named bots, drops groups, and sends the bearer token", async () => {
    const path = discoveryFile({ port: 4545, token: "secret-token" });
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    const gateway = makeGrokBotGateway(path, async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse([
        { id: "yt", name: " YT desk ", description: "Video ideas" },
        { id: "team", name: "Team", isGroup: true },
      ]);
    });
    await expect(gateway.listBots()).resolves.toEqual([
      { botId: "yt", name: "YT desk", description: "Video ideas" },
    ]);
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:4545/api/listAgents",
        authorization: "Bearer secret-token",
        body: {},
      },
    ]);
  });

  it("sends prompts with the message id as the nonce and reads acceptance", async () => {
    const path = discoveryFile({ port: 4545 });
    const bodies: unknown[] = [];
    const gateway = makeGrokBotGateway(path, async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return String(input).endsWith("/sendPrompt")
        ? jsonResponse({ accepted: true })
        : jsonResponse({ outcome: "found", record: { status: "pending" } });
    });
    await gateway.sendPrompt({ botId: "yt" as CirceBotId, prompt: "Hi", nonce: "m-1" });
    await expect(gateway.acceptance({ botId: "yt" as CirceBotId, nonce: "m-1" })).resolves.toBe(
      "pending",
    );
    expect(bodies).toEqual([
      { agentId: "yt", prompt: "Hi", clientNonce: "m-1", directAddressedAcceptance: true },
      { accountSlot: "host", agentId: "yt", clientNonce: "m-1" },
    ]);
  });

  it("reports refusals and malformed answers without echoing the response", async () => {
    const path = discoveryFile({ port: 4545, token: "secret-token" });
    const refused = makeGrokBotGateway(path, async () =>
      jsonResponse({ error: "secret-token leaked" }, 401),
    );
    const error = await refused.listBots().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GrokBotGatewayError);
    expect(String((error as Error).message)).not.toContain("secret-token");

    const malformed = makeGrokBotGateway(path, async () => jsonResponse({ agents: [] }));
    await expect(malformed.listBots()).rejects.toMatchObject({ failure: "invalid" });
  });
});

describe("Grok Bot prompt and reply route", () => {
  it("tells the bot how to hand its answer back", () => {
    const prompt = grokBotPrompt({
      text: "Draft the launch post",
      nodeLabel: "Studio",
      replyUrl: "http://127.0.0.1:4100/api/circe/bot-replies/abc",
    });
    expect(prompt.startsWith("Draft the launch post")).toBe(true);
    expect(prompt).toContain(
      "curl -fsS -X POST --data-binary @/absolute/path/to/answer.txt http://127.0.0.1:4100/api/circe/bot-replies/abc",
    );
    expect(prompt).toContain("x-circe-reply: error");
  });

  it("accepts only loopback callers", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("100.64.0.2")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.4")).toBe(false);
  });
});
