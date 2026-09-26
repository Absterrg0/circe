// @effect-diagnostics nodeBuiltinImport:off - bounded reads of a foreign discovery file
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CirceBot, CirceBotId } from "@circe/contracts";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Client for the local Grok Bot gateway: a loopback HTTP service the Grok Bot
 * app runs on its own computer and describes in a discovery file. The file
 * names a port and an optional bearer token, so it is re-read on every call:
 * the gateway may restart on a new port, and the token never leaves this
 * process. The protocol is the same one Cohall's `grok-bot` provider speaks
 * (https://github.com/AksharP5/cohall); it is not a published Grok API and
 * may change with Grok Bot updates.
 */

const MAX_DISCOVERY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_GROK_BOTS = 256;

const Discovery = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  host: Schema.optionalKey(Schema.NonEmptyString),
  scheme: Schema.optionalKey(Schema.Literals(["http", "https"])),
  token: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
});

const RosterEntry = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  name: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  description: Schema.optionalKey(Schema.String),
  isGroup: Schema.optionalKey(Schema.Boolean),
});
const Roster = Schema.Array(RosterEntry).check(Schema.isMaxLength(1024));

const AcceptanceResponse = Schema.Union([
  Schema.Struct({ outcome: Schema.Literals(["not-found", "unknown-durability"]) }),
  Schema.Struct({
    outcome: Schema.Literal("found"),
    record: Schema.Struct({ status: Schema.Literals(["accepted", "pending", "rejected"]) }),
  }),
]);

const SendResponse = Schema.Struct({ accepted: Schema.Literal(true) });

const decodeDiscovery = Schema.decodeUnknownOption(Discovery);
const decodeRoster = Schema.decodeUnknownOption(Roster);
const decodeAcceptance = Schema.decodeUnknownOption(AcceptanceResponse);
const decodeSend = Schema.decodeUnknownOption(SendResponse);

export type GrokBotAcceptance =
  | "not-found"
  | "unknown-durability"
  | "accepted"
  | "pending"
  | "rejected";

export type GrokBotGatewayFailure = "unreadable" | "not-loopback" | "unreachable" | "invalid";

/** Messages are safe to show: they never contain the token or a response body. */
export class GrokBotGatewayError extends Error {
  readonly failure: GrokBotGatewayFailure;
  constructor(failure: GrokBotGatewayFailure, message: string) {
    super(message);
    this.failure = failure;
  }
}

export interface GrokBotConnection {
  readonly url: string;
  readonly token: string | undefined;
}

export interface GrokBotGateway {
  readonly listBots: (signal?: AbortSignal) => Promise<ReadonlyArray<CirceBot>>;
  readonly sendPrompt: (input: {
    readonly botId: CirceBotId;
    readonly prompt: string;
    readonly nonce: string;
  }) => Promise<void>;
  readonly acceptance: (input: {
    readonly botId: CirceBotId;
    readonly nonce: string;
  }) => Promise<GrokBotAcceptance>;
}

/**
 * The discovery file this node uses, or null when none is configured.
 * `CIRCE_GROK_GATEWAY` wins; otherwise the Grok Bot app's default location is
 * used only when that file exists.
 */
export async function resolveGrokBotDiscoveryPath(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
  readonly exists: (path: string) => Promise<boolean>;
}): Promise<string | null> {
  const configured = input.env["CIRCE_GROK_GATEWAY"]?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  const fallback = NodePath.join(input.homeDir, "agent-data", "gateway.json");
  return (await input.exists(fallback)) ? fallback : null;
}

/** Resolve the discovery file from this process's environment and home directory. */
export function defaultGrokBotDiscoveryPath(): Promise<string | null> {
  return resolveGrokBotDiscoveryPath({
    env: process.env,
    homeDir: NodeOS.homedir(),
    exists: (path) =>
      NodeFSP.access(path).then(
        () => true,
        () => false,
      ),
  });
}

/** Map the discovery host onto loopback, or reject a host that is not local. */
export function loopbackGatewayHost(host: string | undefined): string | null {
  const value = host ?? "127.0.0.1";
  if (value === "0.0.0.0" || value === "localhost") return "127.0.0.1";
  if (value === "::" || value === "::1" || value === "[::1]") return "[::1]";
  return NodeNet.isIP(value) === 4 && value.startsWith("127.") ? value : null;
}

export async function readGrokBotConnection(path: string): Promise<GrokBotConnection> {
  let raw: unknown;
  try {
    const file = await NodeFSP.open(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_DISCOVERY_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_DISCOVERY_BYTES) throw new Error("too large");
      raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    throw new GrokBotGatewayError(
      "unreadable",
      "Circe cannot read the Grok Bot gateway discovery file. Check that Grok Bot is running on this computer.",
    );
  }
  const decoded = decodeDiscovery(raw);
  if (decoded._tag === "None") {
    throw new GrokBotGatewayError("invalid", "The Grok Bot gateway discovery file is not valid.");
  }
  const host = loopbackGatewayHost(decoded.value.host);
  if (host === null) {
    throw new GrokBotGatewayError(
      "not-loopback",
      "The Grok Bot gateway must listen on this computer's loopback address.",
    );
  }
  return {
    url: `${decoded.value.scheme ?? "http"}://${host}:${decoded.value.port}`,
    token:
      decoded.value.token === undefined || decoded.value.token.length === 0
        ? undefined
        : decoded.value.token,
  };
}

async function readBounded(response: Response): Promise<unknown> {
  if (response.body === null) {
    throw new GrokBotGatewayError("invalid", "Grok Bot returned an empty response.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new GrokBotGatewayError("invalid", "Grok Bot returned more than 4 MiB.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new GrokBotGatewayError("invalid", "Grok Bot returned a response Circe cannot read.");
  }
}

export function makeGrokBotGateway(
  discoveryPath: string,
  fetchImpl: typeof fetch = fetch,
): GrokBotGateway {
  const call = async <A>(
    method: string,
    body: object,
    decode: (input: unknown) => Option.Option<A>,
    signal?: AbortSignal,
  ): Promise<A> => {
    const connection = await readGrokBotConnection(discoveryPath);
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await fetchImpl(`${connection.url}/api/${method}`, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-sand-slim-avatars": "1",
          ...(connection.token === undefined
            ? {}
            : { authorization: `Bearer ${connection.token}` }),
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch {
      // Fetch errors can echo request headers; report a fixed message.
      throw new GrokBotGatewayError(
        "unreachable",
        "Circe cannot reach the Grok Bot gateway on this computer.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GrokBotGatewayError(
        "unreachable",
        `The Grok Bot gateway refused ${method} (HTTP ${response.status}).`,
      );
    }
    const json = await readBounded(response);
    const decoded = decode(json);
    if (decoded._tag === "None") {
      throw new GrokBotGatewayError(
        "invalid",
        `Grok Bot answered ${method} in a format this Circe version does not understand.`,
      );
    }
    return decoded.value;
  };

  return {
    listBots: async (signal) => {
      const roster = await call("listAgents", {}, decodeRoster, signal);
      const bots = roster.filter((entry) => entry.isGroup !== true);
      if (bots.length > MAX_GROK_BOTS) {
        throw new GrokBotGatewayError("invalid", "Grok Bot lists more than 256 bots.");
      }
      if (new Set(bots.map((bot) => bot.id)).size !== bots.length) {
        throw new GrokBotGatewayError("invalid", "Grok Bot listed the same bot twice.");
      }
      return bots.map((bot) => ({
        botId: bot.id.trim() as CirceBotId,
        name: bot.name.trim(),
        description:
          bot.description === undefined || bot.description.trim().length === 0
            ? null
            : bot.description.trim().slice(0, 512),
      }));
    },
    sendPrompt: async ({ botId, prompt, nonce }) => {
      await call(
        "sendPrompt",
        { agentId: botId, prompt, clientNonce: nonce, directAddressedAcceptance: true },
        decodeSend,
      );
    },
    acceptance: async ({ botId, nonce }) => {
      const result = await call(
        "promptAcceptanceStatus",
        { accountSlot: "host", agentId: botId, clientNonce: nonce },
        decodeAcceptance,
      );
      return result.outcome === "found" ? result.record.status : result.outcome;
    },
  };
}

/**
 * The prompt a bot receives. The reply URL is the only way the answer reaches
 * Circe, so the instructions are explicit about the callback and about the
 * chat message not counting.
 */
export function grokBotPrompt(input: {
  readonly text: string;
  readonly nodeLabel: string;
  readonly replyUrl: string;
}): string {
  return [
    input.text,
    `This message came to you through Circe from ${input.nodeLabel}.`,
    "When you finish, hand your final answer back to Circe so it reaches the user. Write the answer to a UTF-8 file on this computer, then run:",
    `curl -fsS -X POST --data-binary @/absolute/path/to/answer.txt ${input.replyUrl}`,
    "If you cannot complete the request, report why instead:",
    `curl -fsS -X POST -H 'x-circe-reply: error' --data-binary 'The reason' ${input.replyUrl}`,
    "The command must succeed. A chat message alone does not reach Circe. After the command succeeds, post the same answer in this chat.",
  ].join("\n\n");
}
