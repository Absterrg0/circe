import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Named Grok Bots reached through the Grok Bot gateway on the node that runs
 * them. A bot belongs to its node the way a project does: clients address it
 * as (node, bot), and a disconnected node reports its bots as unavailable
 * instead of moving the conversation elsewhere.
 *
 * The gateway accepts a prompt but does not return the answer. Each message
 * carries a one-time loopback reply URL; the bot hands its answer back through
 * that URL, and only that callback completes the message.
 */
export const CirceBotId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("CirceBotId"),
);
export type CirceBotId = typeof CirceBotId.Type;

export const CirceBotMessageId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("CirceBotMessageId"),
);
export type CirceBotMessageId = typeof CirceBotMessageId.Type;

export const CIRCE_BOT_MESSAGE_MAX_CHARS = 16_000;

/**
 * A bot as a place in the Circe host layer's world. The place id names the
 * bot's project. Each conversation Circe starts with the bot is its own
 * thread, so circe-core sees the thread a start created and watches it for
 * the bot's answer. Host focus and navigate carry these ids, so clients map
 * them to the bot page instead of a thread.
 */
const CIRCE_BOT_PLACE_PREFIX = "bot:";
const CIRCE_BOT_CONVERSATION_PATTERN = /^botchat:\d+:(.+)$/u;

export function circeBotPlaceId(botId: string): string {
  return `${CIRCE_BOT_PLACE_PREFIX}${botId}`;
}

/** The thread for the `generation`th conversation Circe started with a bot. */
export function circeBotConversationId(botId: string, generation: number): string {
  return `botchat:${generation}:${botId}`;
}

/** The bot a place or conversation id names, or null for any other project or thread id. */
export function circeBotIdOfPlace(id: string | undefined): CirceBotId | null {
  if (id === undefined) return null;
  const conversation = CIRCE_BOT_CONVERSATION_PATTERN.exec(id);
  if (conversation !== null) return conversation[1] as CirceBotId;
  if (!id.startsWith(CIRCE_BOT_PLACE_PREFIX) || id.length === CIRCE_BOT_PLACE_PREFIX.length) {
    return null;
  }
  return id.slice(CIRCE_BOT_PLACE_PREFIX.length) as CirceBotId;
}
/**
 * The longest reply Circe stores, in characters. The reply route admits at
 * most 512 KiB of UTF-8, which is never more characters than this, so every
 * reply the route accepts is kept whole; a longer one is refused there.
 */
export const CIRCE_BOT_REPLY_MAX_CHARS = 524_288;

export const CirceBot = Schema.Struct({
  botId: CirceBotId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export type CirceBot = typeof CirceBot.Type;

/**
 * Whether this node can reach a Grok Bot gateway. `unconfigured` means no
 * discovery file exists; `unsupported` means the node's preset does not run
 * agents; `unavailable` means the file exists but the gateway did not answer.
 */
export const CirceBotGateway = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready") }),
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  Schema.Struct({ status: Schema.Literal("unsupported") }),
  Schema.Struct({ status: Schema.Literal("unavailable"), message: TrimmedNonEmptyString }),
]);
export type CirceBotGateway = typeof CirceBotGateway.Type;

export const CirceBotSummary = Schema.Struct({
  bot: CirceBot,
  /** False when a stored conversation names a bot the gateway no longer lists. */
  listed: Schema.Boolean,
  lastMessagePreview: Schema.NullOr(Schema.String.check(Schema.isMaxLength(160))),
  lastMessageAt: Schema.NullOr(IsoDateTime),
  /** Messages still waiting for the bot's reply. */
  waiting: NonNegativeInt,
});
export type CirceBotSummary = typeof CirceBotSummary.Type;

export const CirceBotsState = Schema.Struct({
  gateway: CirceBotGateway,
  bots: Schema.Array(CirceBotSummary),
});
export type CirceBotsState = typeof CirceBotsState.Type;

/**
 * `waiting` means the gateway accepted the prompt and the reply URL is open.
 * `expired` covers both the reply deadline passing and the user choosing to
 * stop waiting; either way the bot may still be working in Grok.
 */
export const CirceBotDelivery = Schema.Literals([
  "sending",
  "waiting",
  "answered",
  "failed",
  "expired",
]);
export type CirceBotDelivery = typeof CirceBotDelivery.Type;

export const CirceBotUserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  messageId: CirceBotMessageId,
  botId: CirceBotId,
  text: Schema.String,
  createdAt: IsoDateTime,
  delivery: CirceBotDelivery,
  error: Schema.NullOr(Schema.String),
  replyDeadlineAt: Schema.NullOr(IsoDateTime),
});
export type CirceBotUserMessage = typeof CirceBotUserMessage.Type;

export const CirceBotReplyMessage = Schema.Struct({
  role: Schema.Literal("bot"),
  messageId: CirceBotMessageId,
  botId: CirceBotId,
  text: Schema.String,
  createdAt: IsoDateTime,
  inReplyTo: CirceBotMessageId,
  outcome: Schema.Literals(["answer", "error"]),
});
export type CirceBotReplyMessage = typeof CirceBotReplyMessage.Type;

export const CirceBotMessage = Schema.Union([CirceBotUserMessage, CirceBotReplyMessage]);
export type CirceBotMessage = typeof CirceBotMessage.Type;

export const CirceBotConversation = Schema.Struct({
  botId: CirceBotId,
  messages: Schema.Array(CirceBotMessage),
});
export type CirceBotConversation = typeof CirceBotConversation.Type;

export const CirceBotsSubscribeInput = Schema.Struct({});
export type CirceBotsSubscribeInput = typeof CirceBotsSubscribeInput.Type;

export const CirceBotsRefreshInput = Schema.Struct({});
export type CirceBotsRefreshInput = typeof CirceBotsRefreshInput.Type;

export const CirceBotSendInput = Schema.Struct({
  botId: CirceBotId,
  /** Client-generated; resending the same id never prompts the bot twice. */
  messageId: CirceBotMessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CIRCE_BOT_MESSAGE_MAX_CHARS)),
});
export type CirceBotSendInput = typeof CirceBotSendInput.Type;

export const CirceBotConversationInput = Schema.Struct({ botId: CirceBotId });
export type CirceBotConversationInput = typeof CirceBotConversationInput.Type;

export const CirceBotStopWaitingInput = Schema.Struct({
  botId: CirceBotId,
  messageId: CirceBotMessageId,
});
export type CirceBotStopWaitingInput = typeof CirceBotStopWaitingInput.Type;

export const CirceBotErrorCode = Schema.Literals([
  "unsupported",
  "gateway-unconfigured",
  "gateway-unavailable",
  "bot-not-found",
  "message-conflict",
  "rejected",
  "unconfirmed",
  "storage",
]);
export type CirceBotErrorCode = typeof CirceBotErrorCode.Type;

export class CirceBotError extends Schema.TaggedError<CirceBotError>()("CirceBotError", {
  code: CirceBotErrorCode,
  message: TrimmedNonEmptyString,
}) {}
