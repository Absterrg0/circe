import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { CIRCE_BOT_REPLY_ROUTE_PREFIX } from "../Layers/CirceBots.ts";
import { CirceBots, type CirceBotsShape } from "../Services/CirceBots.ts";

/** UTF-8 upper bound for the longest reply Circe stores. */
const MAX_REPLY_BYTES = 512 * 1024;

export function isLoopbackAddress(address: string): boolean {
  const value = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return value === "::1" || value.startsWith("127.");
}

const handleReply = (bots: CirceBotsShape) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const remote = request.remoteAddress;
    if (Option.isSome(remote) && !isLoopbackAddress(remote.value)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
    const token = url.value.pathname.slice(`${CIRCE_BOT_REPLY_ROUTE_PREFIX}/`.length);
    if (!/^[a-f0-9]{16,128}$/.test(token)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const length = Number(request.headers["content-length"]);
    if (!Number.isInteger(length) || length < 0) {
      return HttpServerResponse.text("Send the reply with a Content-Length header.", {
        status: 411,
      });
    }
    if (length > MAX_REPLY_BYTES) {
      return HttpServerResponse.text("The reply is longer than Circe accepts.", { status: 413 });
    }
    const text = yield* request.text.pipe(Effect.orElseSucceed(() => null));
    if (text === null) return HttpServerResponse.text("Bad Request", { status: 400 });
    const kind =
      request.headers["x-circe-reply"]?.trim().toLowerCase() === "error" ? "error" : "answer";
    const outcome = yield* bots
      .acceptReply({ token, kind, text })
      .pipe(Effect.orElseSucceed(() => "failed" as const));
    switch (outcome) {
      case "accepted":
      case "duplicate":
        return HttpServerResponse.text("Circe received the reply.\n", { status: 200 });
      case "conflict":
        return HttpServerResponse.text("A different reply was already delivered.\n", {
          status: 409,
        });
      case "closed":
        return HttpServerResponse.text("Circe is no longer waiting for this reply.\n", {
          status: 410,
        });
      case "unknown":
        return HttpServerResponse.text("Not Found", { status: 404 });
      case "failed":
        return HttpServerResponse.text("Circe could not save the reply. Try again.\n", {
          status: 503,
        });
    }
  });

/**
 * The bot's callback. The token in the path is the only credential, so the
 * route also refuses callers that are not on this computer: a bot and its
 * gateway always run beside the node that prompted it.
 */
export const circeBotReplyRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const bots = yield* CirceBots;
    return HttpRouter.add("POST", `${CIRCE_BOT_REPLY_ROUTE_PREFIX}/*`, handleReply(bots));
  }),
);
