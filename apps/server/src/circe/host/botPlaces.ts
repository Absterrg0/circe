import { circeBotPlaceId } from "@circe/contracts";

import type { CirceBotPlace } from "../Services/CirceBots.ts";
import type { Project, Thread } from "./core.ts";

/**
 * Grok Bots in circe-core's world. circe-core knows projects (places work
 * can go) and threads (work in a place), so each bot is both: a project the
 * user can send work to, holding the one conversation the bot keeps in Grok.
 * The same `bot:` id names the project and its thread, which keeps a bot's
 * ids apart from orchestration ids, and lets the host route an operation on
 * either one back to the bot.
 *
 * The thread's state follows the latest message: waiting on the bot reads as
 * running, an answer as finished work, and an error reply or a failed send
 * as a failure. A message nobody is waiting on any more reads as idle with
 * its reason. circe-core derives its notices from those changes.
 */

const MAX_TEXT = 300;

export function botProject(place: CirceBotPlace): Project {
  const about = place.bot.description ?? "Answers with its own tools and knowledge.";
  return {
    id: circeBotPlaceId(place.bot.botId),
    name: place.bot.name,
    about: `A Grok Bot, not a codebase: ${about}`,
  };
}

export function botThread(place: CirceBotPlace, nowMs: number): Thread {
  const { lastSent, lastReply } = place;
  const replyIsLatest = lastReply !== null && (lastSent === null || lastReply.at >= lastSent.at);
  const runState: Thread["runState"] =
    lastSent !== null && (lastSent.delivery === "sending" || lastSent.delivery === "waiting")
      ? "running"
      : replyIsLatest
        ? lastReply.outcome === "error"
          ? "errored"
          : "idle"
        : lastSent?.delivery === "failed"
          ? "errored"
          : "idle";
  // An expired message is not a failure: the user stopped waiting, or the
  // reply window closed, and the bot may still be working in Grok.
  const closedWithoutReply =
    !replyIsLatest &&
    lastSent !== null &&
    (lastSent.delivery === "failed" || lastSent.delivery === "expired");
  const lastAgentMessage = closedWithoutReply
    ? (lastSent.error ?? "The bot did not reply.")
    : lastReply === null
      ? undefined
      : lastReply.outcome === "error"
        ? `Could not finish: ${lastReply.text}`
        : lastReply.text;
  const latestAt = [lastSent?.at, lastReply?.at]
    .filter((at): at is string => at !== undefined)
    .toSorted()
    .at(-1);
  const latestMs = latestAt === undefined ? Number.NaN : Date.parse(latestAt);
  return {
    id: circeBotPlaceId(place.bot.botId),
    projectId: circeBotPlaceId(place.bot.botId),
    title: `${place.bot.name} (Grok Bot)`,
    runState,
    lastActivityMinutesAgo: Number.isNaN(latestMs) ? 0 : Math.max(0, (nowMs - latestMs) / 60_000),
    task: lastSent === null ? `Conversation with ${place.bot.name}` : clip(lastSent.text),
    ...(lastSent === null ? {} : { lastUserMessage: clip(lastSent.text) }),
    ...(lastAgentMessage === undefined ? {} : { lastAgentMessage: clip(lastAgentMessage) }),
    queued: [],
  };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= MAX_TEXT ? flat : `${flat.slice(0, MAX_TEXT - 1)}…`;
}
