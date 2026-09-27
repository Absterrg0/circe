import {
  CIRCE_BOT_REPLY_MAX_CHARS,
  CirceBotError,
  circeNodeCapabilitiesForPreset,
  type CirceBot,
  type CirceBotConversation,
  type CirceBotDelivery,
  type CirceBotErrorCode,
  type CirceBotGateway,
  type CirceBotId,
  type CirceBotMessage,
  type CirceBotMessageId,
  type CirceBotSendInput,
  type CirceBotStopWaitingInput,
  type CirceBotSummary,
  type CirceBotUserMessage,
  type CirceBotsState,
} from "@circe/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import {
  GrokBotGatewayError,
  defaultGrokBotDiscoveryPath,
  grokBotPrompt,
  makeGrokBotGateway,
  type GrokBotGateway,
} from "../bots/grokBotGateway.ts";
import { CirceBots, type CirceBotPlace, type CirceBotReplyOutcome } from "../Services/CirceBots.ts";

/** Matches Cohall's bot reply window; the bot may run long tool loops. */
export const CIRCE_BOT_REPLY_WINDOW_MS = 6 * 60 * 60 * 1000;
export const CIRCE_BOT_REPLY_ROUTE_PREFIX = "/api/circe/bot-replies";
const CONVERSATION_LIMIT = 200;
const PREVIEW_CHARS = 160;

export interface CirceBotsOptions {
  /** Discovery file for this node's gateway, or null when none exists. */
  readonly resolveDiscoveryPath?: () => Promise<string | null>;
  readonly makeGateway?: (discoveryPath: string) => GrokBotGateway;
  /** Loopback origin the bot calls back on, such as http://127.0.0.1:3773. */
  readonly replyOrigin?: Effect.Effect<string | null>;
  readonly newToken?: () => string;
}

interface Roster {
  readonly gateway: CirceBotGateway;
  readonly bots: ReadonlyArray<CirceBot>;
}

interface MessageRow {
  readonly messageId: string;
  readonly botId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly delivery: string | null;
  readonly error: string | null;
  readonly replyToken: string | null;
  readonly replyDeadlineAt: string | null;
  readonly inReplyTo: string | null;
  readonly outcome: string | null;
}

const botError = (code: CirceBotErrorCode, message: string) => new CirceBotError({ code, message });

const storageError = (cause: unknown) =>
  Effect.logWarning("Circe bot storage failed", { cause: String(cause) }).pipe(
    Effect.andThen(Effect.fail(botError("storage", "Circe could not save the bot conversation."))),
  );

const DELIVERIES: ReadonlySet<string> = new Set<CirceBotDelivery>([
  "sending",
  "waiting",
  "answered",
  "failed",
  "expired",
]);

function toMessage(row: MessageRow): CirceBotMessage {
  if (row.role === "bot") {
    return {
      role: "bot",
      messageId: row.messageId as CirceBotMessageId,
      botId: row.botId as CirceBotId,
      text: row.text,
      createdAt: row.createdAt,
      inReplyTo: (row.inReplyTo ?? "") as CirceBotMessageId,
      outcome: row.outcome === "error" ? "error" : "answer",
    };
  }
  return toUserMessage(row);
}

function toUserMessage(row: MessageRow): CirceBotUserMessage {
  return {
    role: "user",
    messageId: row.messageId as CirceBotMessageId,
    botId: row.botId as CirceBotId,
    text: row.text,
    createdAt: row.createdAt,
    delivery:
      row.delivery !== null && DELIVERIES.has(row.delivery)
        ? (row.delivery as CirceBotDelivery)
        : "failed",
    error: row.error,
    replyDeadlineAt: row.replyDeadlineAt,
  };
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`;
}

function gatewayMessage(cause: unknown): string {
  return cause instanceof GrokBotGatewayError
    ? cause.message
    : "Circe cannot reach the Grok Bot gateway on this computer.";
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** 256 random bits as hex, from Web Crypto so the layer stays platform-neutral. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const make = (options: CirceBotsOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const httpServer = yield* Effect.serviceOption(HttpServer.HttpServer);
    const newToken = options.newToken ?? randomToken;
    const resolveDiscoveryPath = options.resolveDiscoveryPath ?? defaultGrokBotDiscoveryPath;
    const makeGateway = options.makeGateway ?? ((path: string) => makeGrokBotGateway(path));
    const replyOrigin =
      options.replyOrigin ??
      Effect.sync(() => {
        if (Option.isNone(httpServer)) return null;
        const address = httpServer.value.address;
        return typeof address === "string" || !("port" in address)
          ? null
          : `http://127.0.0.1:${address.port}`;
      });
    const runsAgents = circeNodeCapabilitiesForPreset(config.circeNodePreset ?? "full").execution;

    const roster = yield* Ref.make<Roster | null>(null);
    // `null` announces a roster change; a bot id announces that bot's messages.
    const changes = yield* PubSub.unbounded<CirceBotId | null>();

    const gatewayFor = Effect.fn("CirceBots.gatewayFor")(function* () {
      const path = yield* Effect.promise(() => resolveDiscoveryPath());
      return path === null ? null : makeGateway(path);
    });

    /**
     * Expires every message past its reply deadline and announces each
     * affected bot. The reply token stays, so a bot answering late is told
     * the window closed rather than that the address is unknown.
     */
    const expireOverdue = () =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        const expired = yield* sql<{ readonly botId: string }>`
          UPDATE circe_bot_messages
          SET delivery = 'expired',
              error = 'No reply arrived before the deadline. The bot may still be working in Grok.'
          WHERE role = 'user' AND delivery IN ('sending', 'waiting')
            AND reply_deadline_at IS NOT NULL AND reply_deadline_at <= ${at}
          RETURNING bot_id AS botId
        `;
        for (const botId of new Set(expired.map((row) => row.botId))) {
          yield* PubSub.publish(changes, botId as CirceBotId);
        }
      });

    /**
     * Wakes at the nearest reply deadline, so an open conversation stops
     * showing a wait that already ended. It sleeps until that deadline or
     * the next change to any conversation, whichever comes first; nothing
     * polls.
     */
    const expiryWatch = Effect.scoped(
      Effect.gen(function* () {
        const woken = yield* PubSub.subscribe(changes);
        for (;;) {
          const next = yield* sql<{ readonly deadline: string | null }>`
            SELECT MIN(reply_deadline_at) AS deadline FROM circe_bot_messages
            WHERE role = 'user' AND delivery IN ('sending', 'waiting')
              AND reply_deadline_at IS NOT NULL
          `.pipe(Effect.orElseSucceed(() => []));
          const deadline = next[0]?.deadline ?? null;
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          const waitMs = deadline === null ? null : Date.parse(deadline) - now;
          if (waitMs === null) {
            yield* PubSub.take(woken);
          } else if (waitMs > 0) {
            yield* Effect.raceFirst(
              Effect.sleep(Duration.millis(waitMs)),
              PubSub.take(woken).pipe(Effect.asVoid),
            );
          }
          const expired = yield* expireOverdue().pipe(Effect.result);
          // A storage failure waits for the next change instead of retrying at once.
          if (expired._tag === "Failure") {
            yield* Effect.logWarning("Circe could not expire overdue bot messages", {
              error: expired.failure,
            });
            yield* PubSub.take(woken);
          }
        }
      }),
    );

    const loadRoster = Effect.fn("CirceBots.loadRoster")(function* () {
      if (!runsAgents) return { gateway: { status: "unsupported" }, bots: [] } satisfies Roster;
      const gateway = yield* gatewayFor();
      if (gateway === null) {
        return { gateway: { status: "unconfigured" }, bots: [] } satisfies Roster;
      }
      const listed = yield* Effect.tryPromise({
        try: (signal) => gateway.listBots(signal),
        catch: gatewayMessage,
      }).pipe(Effect.result);
      if (listed._tag === "Failure") {
        return {
          gateway: { status: "unavailable", message: listed.failure },
          bots: [],
        } satisfies Roster;
      }
      const seenAt = yield* nowIso;
      yield* Effect.forEach(
        listed.success,
        (bot) => sql`
          INSERT INTO circe_bots (bot_id, name, description, last_seen_at)
          VALUES (${bot.botId}, ${bot.name}, ${bot.description}, ${seenAt})
          ON CONFLICT(bot_id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            last_seen_at = excluded.last_seen_at
        `,
        { discard: true },
      ).pipe(Effect.catch(storageError));
      return { gateway: { status: "ready" }, bots: listed.success } satisfies Roster;
    });

    const refreshRoster = Effect.fn("CirceBots.refreshRoster")(function* () {
      const next = yield* loadRoster();
      yield* Ref.set(roster, next);
      yield* PubSub.publish(changes, null);
      return next;
    });

    const currentRoster = Effect.gen(function* () {
      const cached = yield* Ref.get(roster);
      return cached ?? (yield* refreshRoster());
    });

    const buildState = Effect.fn("CirceBots.buildState")(function* () {
      const current = yield* currentRoster;
      yield* expireOverdue().pipe(Effect.catch(storageError));
      const rows = yield* sql<{
        readonly botId: string;
        readonly name: string;
        readonly description: string | null;
        readonly lastText: string | null;
        readonly lastAt: string | null;
        readonly waiting: number;
      }>`
        SELECT b.bot_id AS botId, b.name AS name, b.description AS description,
          (SELECT m.text FROM circe_bot_messages m WHERE m.bot_id = b.bot_id
            ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS lastText,
          (SELECT m.created_at FROM circe_bot_messages m WHERE m.bot_id = b.bot_id
            ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS lastAt,
          (SELECT COUNT(*) FROM circe_bot_messages m WHERE m.bot_id = b.bot_id
            AND m.role = 'user' AND m.delivery IN ('sending', 'waiting')) AS waiting
        FROM circe_bots b
      `.pipe(Effect.catch(storageError));
      const stored = new Map(rows.map((row) => [row.botId, row]));
      const summary = (bot: CirceBot, listed: boolean): CirceBotSummary => {
        const row = stored.get(bot.botId);
        return {
          bot,
          listed,
          lastMessagePreview: row?.lastText == null ? null : preview(row.lastText),
          lastMessageAt: row?.lastAt ?? null,
          waiting: Number(row?.waiting ?? 0),
        };
      };
      const listedIds = new Set(current.bots.map((bot) => bot.botId));
      // Bots the gateway stopped listing stay visible while they hold a
      // conversation, so the user can read it and see that the bot is gone.
      const unlisted = rows
        .filter((row) => !listedIds.has(row.botId as CirceBotId) && row.lastAt !== null)
        .map((row) =>
          summary(
            { botId: row.botId as CirceBotId, name: row.name, description: row.description },
            false,
          ),
        );
      return {
        gateway: current.gateway,
        bots: [...current.bots.map((bot) => summary(bot, true)), ...unlisted],
      } satisfies CirceBotsState;
    });

    const readConversation = Effect.fn("CirceBots.readConversation")(function* (botId: CirceBotId) {
      yield* expireOverdue().pipe(Effect.catch(storageError));
      const rows = yield* sql<MessageRow>`
        SELECT * FROM (
          SELECT message_id AS messageId, bot_id AS botId, role, text, created_at AS createdAt,
            delivery, error, reply_token AS replyToken, reply_deadline_at AS replyDeadlineAt,
            in_reply_to AS inReplyTo, outcome, rowid AS position
          FROM circe_bot_messages WHERE bot_id = ${botId}
          ORDER BY created_at DESC, rowid DESC LIMIT ${CONVERSATION_LIMIT}
        ) ORDER BY createdAt ASC, position ASC
      `.pipe(Effect.catch(storageError));
      return { botId, messages: rows.map(toMessage) } satisfies CirceBotConversation;
    });

    const readMessage = (messageId: string) =>
      sql<MessageRow>`
        SELECT message_id AS messageId, bot_id AS botId, role, text, created_at AS createdAt,
          delivery, error, reply_token AS replyToken, reply_deadline_at AS replyDeadlineAt,
          in_reply_to AS inReplyTo, outcome
        FROM circe_bot_messages WHERE message_id = ${messageId}
      `.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.catch(storageError),
      );

    /**
     * Moves a message forward. Transitions only go forward: the gateway's
     * acknowledgement settles a message still `sending`, and nothing
     * overwrites an answer, since a bot can reply before its gateway
     * acknowledges the prompt.
     */
    const setDelivery = (
      messageId: string,
      delivery: CirceBotDelivery,
      error: string | null,
      keepToken: boolean,
      from: "sending" | "unanswered",
    ) => {
      const statement =
        from === "sending"
          ? keepToken
            ? sql`UPDATE circe_bot_messages SET delivery = ${delivery}, error = ${error}
                WHERE message_id = ${messageId} AND delivery = 'sending'`
            : sql`UPDATE circe_bot_messages SET delivery = ${delivery}, error = ${error},
                  reply_token = NULL
                WHERE message_id = ${messageId} AND delivery = 'sending'`
          : keepToken
            ? sql`UPDATE circe_bot_messages SET delivery = ${delivery}, error = ${error}
                WHERE message_id = ${messageId} AND delivery <> 'answered'`
            : sql`UPDATE circe_bot_messages SET delivery = ${delivery}, error = ${error},
                  reply_token = NULL
                WHERE message_id = ${messageId} AND delivery <> 'answered'`;
      return statement.pipe(Effect.catch(storageError));
    };

    const send = Effect.fn("CirceBots.send")(function* (input: CirceBotSendInput) {
      if (!runsAgents) {
        return yield* botError("unsupported", "This Circe node does not run agents or bots.");
      }
      const existing = yield* readMessage(input.messageId);
      if (existing !== null) {
        if (
          existing.role === "user" &&
          existing.botId === input.botId &&
          existing.text === input.text
        ) {
          return toUserMessage(existing);
        }
        return yield* botError("message-conflict", "That message id is already used.");
      }
      const gateway = yield* gatewayFor();
      if (gateway === null) {
        return yield* botError(
          "gateway-unconfigured",
          "No Grok Bot gateway is configured on this node.",
        );
      }
      let current = yield* currentRoster;
      if (!current.bots.some((bot) => bot.botId === input.botId)) {
        current = yield* refreshRoster();
      }
      if (current.gateway.status === "unavailable") {
        return yield* botError("gateway-unavailable", current.gateway.message);
      }
      if (!current.bots.some((bot) => bot.botId === input.botId)) {
        return yield* botError("bot-not-found", "That bot is no longer listed by Grok Bot.");
      }
      const origin = yield* replyOrigin;
      if (origin === null) {
        return yield* botError(
          "gateway-unavailable",
          "Circe cannot open a reply address on this node yet. Try again in a moment.",
        );
      }
      const descriptor = yield* serverEnvironment.getDescriptor;
      const token = newToken();
      const createdAt = yield* DateTime.now;
      const deadline = DateTime.formatIso(
        DateTime.add(createdAt, { milliseconds: CIRCE_BOT_REPLY_WINDOW_MS }),
      );
      yield* sql`
        INSERT INTO circe_bot_messages
          (message_id, bot_id, role, text, created_at, delivery, error, reply_token, reply_deadline_at)
        VALUES (${input.messageId}, ${input.botId}, 'user', ${input.text},
          ${DateTime.formatIso(createdAt)}, 'sending', NULL, ${token}, ${deadline})
      `.pipe(Effect.catch(storageError));
      yield* PubSub.publish(changes, input.botId);

      const prompt = grokBotPrompt({
        text: input.text,
        nodeLabel: descriptor.label,
        replyUrl: `${origin}${CIRCE_BOT_REPLY_ROUTE_PREFIX}/${token}`,
      });
      const sent = yield* Effect.tryPromise({
        try: () => gateway.sendPrompt({ botId: input.botId, prompt, nonce: input.messageId }),
        catch: gatewayMessage,
      }).pipe(Effect.result);

      if (sent._tag === "Success") {
        yield* setDelivery(input.messageId, "waiting", null, true, "sending");
      } else {
        // A failed request may still have reached the bot. Ask the gateway
        // before reporting, so a resend never prompts the bot twice.
        const acceptance = yield* Effect.tryPromise(() =>
          gateway.acceptance({ botId: input.botId, nonce: input.messageId }),
        ).pipe(Effect.orElseSucceed(() => "unknown-durability" as const));
        if (acceptance === "accepted" || acceptance === "pending") {
          yield* setDelivery(input.messageId, "waiting", null, true, "sending");
        } else if (acceptance === "rejected") {
          yield* setDelivery(
            input.messageId,
            "failed",
            "Grok Bot rejected this message. Check the bot's conversation in Grok.",
            false,
            "sending",
          );
        } else if (acceptance === "not-found") {
          yield* setDelivery(input.messageId, "failed", sent.failure, false, "sending");
        } else {
          // Unconfirmed: keep the reply URL open so a late answer still lands.
          yield* setDelivery(
            input.messageId,
            "failed",
            "Circe could not confirm that Grok Bot received this message. Check the bot's conversation before sending it again.",
            true,
            "sending",
          );
        }
      }
      yield* PubSub.publish(changes, input.botId);
      const stored = yield* readMessage(input.messageId);
      if (stored === null) {
        return yield* botError("storage", "Circe could not save the bot conversation.");
      }
      return toUserMessage(stored);
    });

    const acceptReply = Effect.fn("CirceBots.acceptReply")(function* (input: {
      readonly token: string;
      readonly kind: "answer" | "error";
      readonly text: string;
    }) {
      if (input.token.length === 0) return "unknown" satisfies CirceBotReplyOutcome;
      const rows = yield* sql<MessageRow>`
        SELECT message_id AS messageId, bot_id AS botId, role, text, created_at AS createdAt,
          delivery, error, reply_token AS replyToken, reply_deadline_at AS replyDeadlineAt,
          in_reply_to AS inReplyTo, outcome
        FROM circe_bot_messages WHERE reply_token = ${input.token} AND role = 'user'
      `.pipe(Effect.catch(storageError));
      const owner = rows[0];
      if (owner === undefined) return "unknown" satisfies CirceBotReplyOutcome;
      const text = input.text.trim().slice(0, CIRCE_BOT_REPLY_MAX_CHARS);
      const replyId = `${owner.messageId}:reply`;
      if (owner.delivery === "answered") {
        const previous = yield* readMessage(replyId);
        return previous !== null &&
          previous.text === text &&
          previous.outcome === (input.kind === "error" ? "error" : "answer")
          ? ("duplicate" satisfies CirceBotReplyOutcome)
          : ("conflict" satisfies CirceBotReplyOutcome);
      }
      const at = yield* nowIso;
      if (owner.replyDeadlineAt !== null && owner.replyDeadlineAt <= at) {
        yield* expireOverdue().pipe(Effect.catch(storageError));
        yield* PubSub.publish(changes, owner.botId as CirceBotId);
        return "closed" satisfies CirceBotReplyOutcome;
      }
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO circe_bot_messages
                (message_id, bot_id, role, text, created_at, in_reply_to, outcome)
              VALUES (${replyId}, ${owner.botId}, 'bot',
                ${text.length === 0 ? "(The bot replied with no text.)" : text},
                ${at}, ${owner.messageId}, ${input.kind})
            `;
            yield* sql`
              UPDATE circe_bot_messages SET delivery = 'answered', error = NULL
              WHERE message_id = ${owner.messageId}
            `;
          }),
        )
        .pipe(Effect.catch(storageError));
      yield* PubSub.publish(changes, owner.botId as CirceBotId);
      return "accepted" satisfies CirceBotReplyOutcome;
    });

    const stopWaiting = Effect.fn("CirceBots.stopWaiting")(function* (
      input: CirceBotStopWaitingInput,
    ) {
      const row = yield* readMessage(input.messageId);
      if (row === null || row.role !== "user" || row.botId !== input.botId) {
        return yield* botError("bot-not-found", "That message is not part of this conversation.");
      }
      if (row.delivery === "sending" || row.delivery === "waiting" || row.replyToken !== null) {
        if (row.delivery !== "answered") {
          yield* setDelivery(
            row.messageId,
            "expired",
            "Circe stopped waiting. The bot may still be working in Grok.",
            false,
            "unanswered",
          );
          yield* PubSub.publish(changes, input.botId);
        }
      }
      const stored = yield* readMessage(input.messageId);
      return toUserMessage(stored ?? row);
    });

    const clearConversation = Effect.fn("CirceBots.clearConversation")(function* (
      botId: CirceBotId,
    ) {
      yield* sql`DELETE FROM circe_bot_messages WHERE bot_id = ${botId}`.pipe(
        Effect.catch(storageError),
      );
      yield* PubSub.publish(changes, botId);
    });

    const places = Effect.fn("CirceBots.places")(function* () {
      const current = yield* currentRoster;
      if (current.gateway.status !== "ready" || current.bots.length === 0) return [];
      yield* expireOverdue().pipe(Effect.catch(storageError));
      const rows = yield* sql<MessageRow>`
        SELECT message_id AS messageId, bot_id AS botId, role, text, created_at AS createdAt,
          delivery, error, reply_token AS replyToken, reply_deadline_at AS replyDeadlineAt,
          in_reply_to AS inReplyTo, outcome
        FROM circe_bot_messages
        WHERE rowid IN (SELECT MAX(rowid) FROM circe_bot_messages WHERE role = 'user' GROUP BY bot_id)
          OR (role = 'bot' AND in_reply_to IN (
            SELECT message_id FROM circe_bot_messages
            WHERE rowid IN (
              SELECT MAX(rowid) FROM circe_bot_messages WHERE role = 'user' GROUP BY bot_id
            )
          ))
      `.pipe(Effect.catch(storageError));
      return current.bots.map((bot): CirceBotPlace => {
        const sent = rows.find((row) => row.botId === bot.botId && row.role === "user");
        // Only the reply to the latest message is its result: an older
        // message's late answer is not the answer to the one that waits.
        const reply =
          sent === undefined
            ? undefined
            : rows.find((row) => row.role === "bot" && row.inReplyTo === sent.messageId);
        const user = sent === undefined ? null : toUserMessage(sent);
        return {
          bot,
          lastSent:
            user === null
              ? null
              : { text: user.text, at: user.createdAt, delivery: user.delivery, error: user.error },
          lastReply:
            reply === undefined
              ? null
              : {
                  text: reply.text,
                  at: reply.createdAt,
                  outcome: reply.outcome === "error" ? "error" : "answer",
                },
        };
      });
    });

    const subscribe = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = yield* buildState();
          return Stream.concat(
            Stream.make(initial),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => buildState())),
          );
        }),
      );

    const subscribeConversation = (botId: CirceBotId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const initial = yield* readConversation(botId);
          return Stream.concat(
            Stream.make(initial),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changed) => changed === botId),
              Stream.mapEffect(() => readConversation(botId)),
            ),
          );
        }),
      );

    if (runsAgents) yield* Effect.forkScoped(expiryWatch);

    return CirceBots.of({
      subscribe,
      refresh: () => refreshRoster().pipe(Effect.andThen(buildState())),
      send,
      subscribeConversation,
      stopWaiting,
      clearConversation,
      places,
      changes: Stream.fromPubSub(changes).pipe(Stream.map((): void => undefined)),
      acceptReply,
    });
  });

export const CirceBotsLive = Layer.effect(CirceBots, make());
