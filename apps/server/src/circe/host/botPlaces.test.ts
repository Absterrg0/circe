import { circeBotIdOfPlace, type CirceBotId } from "@circe/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CirceBotPlace } from "../Services/CirceBots.ts";
import { botThread } from "./botPlaces.ts";

const bot = { botId: "desk" as CirceBotId, name: "Desk", description: null };
const now = Date.parse("2026-09-26T12:00:00.000Z");
const sent = (
  delivery: "waiting" | "answered" | "failed" | "expired",
  error: string | null = null,
) => ({
  text: "Plan my week",
  at: "2026-09-26T11:00:00.000Z",
  delivery,
  error,
});

function thread(place: Partial<CirceBotPlace>) {
  return botThread({ bot, lastSent: null, lastReply: null, ...place }, now);
}

describe("Grok Bots as circe-core threads", () => {
  it("only treats bot: ids as bots", () => {
    expect(circeBotIdOfPlace("bot:desk")).toBe("desk");
    expect(circeBotIdOfPlace("bot:")).toBeNull();
    expect(circeBotIdOfPlace("thread:1")).toBeNull();
    expect(circeBotIdOfPlace(undefined)).toBeNull();
  });

  it("reads a message waiting on the bot as running work", () => {
    expect(thread({ lastSent: sent("waiting") })).toMatchObject({
      runState: "running",
      task: "Plan my week",
      lastActivityMinutesAgo: 60,
    });
  });

  it("reads an answer as finished work carrying the reply", () => {
    expect(
      thread({
        lastSent: sent("answered"),
        lastReply: { text: "Monday: invoices.", at: "2026-09-26T11:30:00.000Z", outcome: "answer" },
      }),
    ).toMatchObject({ runState: "idle", lastAgentMessage: "Monday: invoices." });
  });

  it("reads an error reply or a failed send as a failure with its reason", () => {
    expect(
      thread({
        lastSent: sent("answered"),
        lastReply: {
          text: "No calendar access.",
          at: "2026-09-26T11:30:00.000Z",
          outcome: "error",
        },
      }),
    ).toMatchObject({
      runState: "errored",
      lastAgentMessage: "Could not finish: No calendar access.",
    });
    expect(thread({ lastSent: sent("failed", "Grok Bot rejected this message.") })).toMatchObject({
      runState: "errored",
      lastAgentMessage: "Grok Bot rejected this message.",
    });
  });

  it("does not report a message nobody waits on any more as a failure", () => {
    expect(
      thread({
        lastSent: sent("expired", "Circe stopped waiting. The bot may still be working in Grok."),
      }),
    ).toMatchObject({
      runState: "idle",
      lastAgentMessage: "Circe stopped waiting. The bot may still be working in Grok.",
    });
    expect(thread({ lastSent: sent("expired") })).toMatchObject({
      runState: "idle",
      lastAgentMessage: "The bot did not reply.",
    });
  });

  it("follows a new message sent after an earlier reply", () => {
    expect(
      thread({
        lastSent: { ...sent("waiting"), at: "2026-09-26T11:50:00.000Z" },
        lastReply: { text: "Old answer", at: "2026-09-26T11:30:00.000Z", outcome: "answer" },
      }),
    ).toMatchObject({ runState: "running", lastAgentMessage: "Old answer" });
  });
});
