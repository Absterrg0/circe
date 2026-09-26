import type {
  CirceBot,
  CirceBotConversation,
  CirceBotDelivery,
  CirceBotError,
  CirceBotId,
  CirceBotSendInput,
  CirceBotStopWaitingInput,
  CirceBotUserMessage,
  CirceBotsState,
} from "@circe/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type CirceBotReplyKind = "answer" | "error";

/**
 * How a reply callback resolved. `accepted` and `duplicate` succeed;
 * `conflict` means a different answer already landed; `closed` means the
 * reply URL expired or the user stopped waiting; `unknown` means no message
 * owns the token.
 */
export type CirceBotReplyOutcome = "accepted" | "duplicate" | "conflict" | "closed" | "unknown";

/**
 * One listed bot as circe-core sees it: a place work can go, with the latest
 * message sent there and the latest reply.
 */
export interface CirceBotPlace {
  readonly bot: CirceBot;
  readonly lastSent: {
    readonly text: string;
    readonly at: string;
    readonly delivery: CirceBotDelivery;
    readonly error: string | null;
  } | null;
  readonly lastReply: {
    readonly text: string;
    readonly at: string;
    readonly outcome: "answer" | "error";
  } | null;
}

/**
 * This node's Grok Bots. The roster is read from the local gateway when a
 * client subscribes or asks for a refresh; nothing polls it. Conversations
 * are recorded here because the gateway returns no answers: each prompt
 * carries a one-time loopback reply URL, and `acceptReply` is the only path
 * that completes a message.
 */
export interface CirceBotsShape {
  readonly subscribe: () => Stream.Stream<CirceBotsState, CirceBotError>;
  readonly refresh: () => Effect.Effect<CirceBotsState, CirceBotError>;
  readonly send: (input: CirceBotSendInput) => Effect.Effect<CirceBotUserMessage, CirceBotError>;
  readonly subscribeConversation: (
    botId: CirceBotId,
  ) => Stream.Stream<CirceBotConversation, CirceBotError>;
  readonly stopWaiting: (
    input: CirceBotStopWaitingInput,
  ) => Effect.Effect<CirceBotUserMessage, CirceBotError>;
  readonly clearConversation: (botId: CirceBotId) => Effect.Effect<void, CirceBotError>;
  /** Bots the gateway lists now; empty when it is not ready. */
  readonly places: () => Effect.Effect<ReadonlyArray<CirceBotPlace>, CirceBotError>;
  /** Fires whenever the roster or any conversation changes. */
  readonly changes: Stream.Stream<void>;
  readonly acceptReply: (input: {
    readonly token: string;
    readonly kind: CirceBotReplyKind;
    readonly text: string;
  }) => Effect.Effect<CirceBotReplyOutcome, CirceBotError>;
}

export class CirceBots extends Context.Service<CirceBots, CirceBotsShape>()(
  "@absterrg0/circe/circe/Services/CirceBots",
) {}
