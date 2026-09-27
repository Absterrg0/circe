// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type CirceBot,
  type CirceBotId,
  type CirceBotMessageId,
  type ExecutionEnvironmentDescriptor,
} from "@circe/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import type { GrokBotAcceptance, GrokBotGateway } from "../bots/grokBotGateway.ts";
import { CirceBots } from "../Services/CirceBots.ts";
import { CIRCE_BOT_REPLY_WINDOW_MS, make, type CirceBotsOptions } from "./CirceBots.ts";

const desk = "desk" as CirceBotId;
const deskBot: CirceBot = { botId: desk, name: "Desk", description: "Plans the day" };
const messageId = (value: string) => value as CirceBotMessageId;

interface FakeGateway {
  bots: CirceBot[];
  listFails: boolean;
  sendFails: boolean;
  acceptance: GrokBotAcceptance;
  prompts: Array<{ botId: string; prompt: string; nonce: string }>;
  /** When set, sendPrompt parks until the test releases it, so a reply can land mid-send. */
  sendGate?: {
    readonly entered: PromiseWithResolvers<void>;
    readonly release: PromiseWithResolvers<void>;
  };
}

const fakeGateway = (): FakeGateway => ({
  bots: [deskBot],
  listFails: false,
  sendFails: false,
  acceptance: "not-found",
  prompts: [],
});

const gatewayFrom = (fake: FakeGateway): GrokBotGateway => ({
  listBots: async () => {
    if (fake.listFails) throw new Error("gateway down");
    return fake.bots;
  },
  sendPrompt: async (input) => {
    if (fake.sendFails) throw new Error("socket closed");
    fake.prompts.push(input);
    if (fake.sendGate !== undefined) {
      fake.sendGate.entered.resolve();
      await fake.sendGate.release.promise;
    }
  },
  acceptance: async () => fake.acceptance,
});

const configLayer = (preset: "full" | "controller") =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return ServerConfig.ServerConfig.of({ ...config, circeNodePreset: preset });
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

const environmentLayer = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("node-one")),
    getDescriptor: Effect.succeed({ label: "Studio" } as ExecutionEnvironmentDescriptor),
    setLabel: () => Effect.die("unused"),
  } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
);

let tokenCounter = 0;

const botsLayer = (
  fake: FakeGateway,
  options: {
    readonly preset?: "full" | "controller";
    readonly configured?: boolean;
  } = {},
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-bots-"));
  const botOptions: CirceBotsOptions = {
    resolveDiscoveryPath: async () =>
      options.configured === false ? null : "/tmp/agent-data/gateway.json",
    makeGateway: () => gatewayFrom(fake),
    replyOrigin: Effect.succeed("http://127.0.0.1:4100"),
    newToken: () => `${(tokenCounter += 1).toString(16).padStart(32, "a")}`,
  };
  return Layer.effect(CirceBots, make(botOptions)).pipe(
    Layer.provideMerge(configLayer(options.preset ?? "full")),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"))),
    Layer.provideMerge(NodeServices.layer),
    Layer.orDie,
  );
};

const refresh = Effect.gen(function* () {
  const bots = yield* CirceBots;
  return yield* bots.refresh();
});

const replyToken = (prompt: string) => {
  const match = /bot-replies\/([a-f0-9]+)/.exec(prompt);
  if (match?.[1] === undefined) throw new Error("prompt carries no reply URL");
  return match[1];
};

it.effect("reports an unconfigured gateway and a preset that does not run bots", () =>
  Effect.gen(function* () {
    const fake = fakeGateway();
    const unconfigured = yield* refresh.pipe(
      Effect.provide(botsLayer(fake, { configured: false })),
    );
    assert.deepStrictEqual(unconfigured, { gateway: { status: "unconfigured" }, bots: [] });

    const controller = yield* refresh.pipe(
      Effect.provide(botsLayer(fake, { preset: "controller" })),
    );
    assert.deepStrictEqual(controller.gateway, { status: "unsupported" });
    const refused = yield* Effect.gen(function* () {
      const bots = yield* CirceBots;
      return yield* bots.send({ botId: desk, messageId: messageId("m-1"), text: "Hello" });
    }).pipe(Effect.provide(botsLayer(fake, { preset: "controller" })), Effect.flip);
    assert.strictEqual(refused.code, "unsupported");
    assert.strictEqual(fake.prompts.length, 0);
  }),
);

it.effect("prompts a bot once and completes the message only through its reply URL", () =>
  Effect.gen(function* () {
    const fake = fakeGateway();
    yield* Effect.gen(function* () {
      const bots = yield* CirceBots;
      const sent = yield* bots.send({ botId: desk, messageId: messageId("m-1"), text: "Plan it" });
      assert.strictEqual(sent.delivery, "waiting");
      assert.strictEqual(fake.prompts.length, 1);
      const prompt = fake.prompts[0]!;
      assert.strictEqual(prompt.nonce, "m-1");
      assert.include(prompt.prompt, "Plan it");
      assert.include(prompt.prompt, "Studio");
      assert.include(prompt.prompt, "http://127.0.0.1:4100/api/circe/bot-replies/");

      // Resending the same client id returns the stored message.
      const again = yield* bots.send({ botId: desk, messageId: messageId("m-1"), text: "Plan it" });
      assert.strictEqual(again.delivery, "waiting");
      assert.strictEqual(fake.prompts.length, 1);
      const conflict = yield* bots
        .send({ botId: desk, messageId: messageId("m-1"), text: "Different" })
        .pipe(Effect.flip);
      assert.strictEqual(conflict.code, "message-conflict");

      const state = yield* bots.refresh();
      assert.strictEqual(state.bots[0]?.waiting, 1);

      const token = replyToken(prompt.prompt);
      assert.strictEqual(
        yield* bots.acceptReply({ token, kind: "answer", text: "Here is the plan." }),
        "accepted",
      );
      assert.strictEqual(
        yield* bots.acceptReply({ token, kind: "answer", text: "Here is the plan." }),
        "duplicate",
      );
      assert.strictEqual(
        yield* bots.acceptReply({ token, kind: "answer", text: "Another plan." }),
        "conflict",
      );
      assert.strictEqual(
        yield* bots.acceptReply({ token: "f".repeat(64), kind: "answer", text: "x" }),
        "unknown",
      );

      const conversation = yield* bots.subscribeConversation(desk).pipe(Stream.runHead);
      assert.strictEqual(conversation._tag, "Some");
      if (conversation._tag !== "Some") return;
      const [question, answer] = conversation.value.messages;
      assert.deepInclude(question, { role: "user", delivery: "answered", error: null });
      assert.deepInclude(answer, {
        role: "bot",
        text: "Here is the plan.",
        inReplyTo: messageId("m-1"),
        outcome: "answer",
      });
      const after = yield* bots.refresh();
      assert.strictEqual(after.bots[0]?.waiting, 0);
      assert.strictEqual(after.bots[0]?.lastMessagePreview, "Here is the plan.");
    }).pipe(Effect.provide(botsLayer(fake)));
  }),
);

it.effect("asks the gateway before reporting a failed send", () =>
  Effect.gen(function* () {
    const fake = fakeGateway();
    yield* Effect.gen(function* () {
      const bots = yield* CirceBots;
      fake.sendFails = true;
      fake.acceptance = "accepted";
      const delivered = yield* bots.send({ botId: desk, messageId: messageId("m-1"), text: "A" });
      assert.strictEqual(delivered.delivery, "waiting");

      fake.acceptance = "not-found";
      const lost = yield* bots.send({ botId: desk, messageId: messageId("m-2"), text: "B" });
      assert.strictEqual(lost.delivery, "failed");
      assert.strictEqual(lost.error, "Circe cannot reach the Grok Bot gateway on this computer.");

      fake.acceptance = "rejected";
      const rejected = yield* bots.send({ botId: desk, messageId: messageId("m-3"), text: "C" });
      assert.strictEqual(rejected.delivery, "failed");
      assert.include(rejected.error ?? "", "rejected");
    }).pipe(Effect.provide(botsLayer(fake)));
  }),
);

it.effect("closes the reply URL when the user stops waiting or the deadline passes", () =>
  Effect.gen(function* () {
    const fake = fakeGateway();
    yield* Effect.gen(function* () {
      const bots = yield* CirceBots;
      yield* bots.send({ botId: desk, messageId: messageId("m-1"), text: "One" });
      yield* bots.send({ botId: desk, messageId: messageId("m-2"), text: "Two" });
      const [first, second] = fake.prompts.map((prompt) => replyToken(prompt.prompt));

      const stopped = yield* bots.stopWaiting({ botId: desk, messageId: messageId("m-1") });
      assert.strictEqual(stopped.delivery, "expired");
      assert.strictEqual(
        yield* bots.acceptReply({ token: first!, kind: "answer", text: "Late" }),
        "unknown",
      );

      yield* TestClock.adjust(CIRCE_BOT_REPLY_WINDOW_MS + 1);
      assert.strictEqual(
        yield* bots.acceptReply({ token: second!, kind: "answer", text: "Too late" }),
        "closed",
      );
      const conversation = yield* bots.subscribeConversation(desk).pipe(Stream.runHead);
      if (conversation._tag !== "Some") throw new Error("missing conversation");
      assert.deepStrictEqual(
        conversation.value.messages.map((message) =>
          message.role === "user" ? message.delivery : message.role,
        ),
        ["expired", "expired"],
      );
    }).pipe(Effect.provide(botsLayer(fake)));
  }),
);

it.effect("tells an open conversation when its wait runs out, with nothing else happening", () =>
  Effect.gen(function* () {
    const fake = fakeGateway();
    yield* Effect.gen(function* () {
      const bots = yield* CirceBots;
      // The conversation is open before the message and stays open.
      const expired = yield* bots.subscribeConversation(desk).pipe(
        Stream.filter((conversation) =>
          conversation.messages.some(
            (message) => message.role === "user" && message.delivery === "expired",
          ),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* bots.send({ botId: desk, messageId: messageId("m-quiet"), text: "Anyone there?" });
      yield* TestClock.adjust(CIRCE_BOT_REPLY_WINDOW_MS + 1);
      const seen = yield* Fiber.join(expired);
      assert.strictEqual(seen._tag, "Some");
    }).pipe(Effect.provide(botsLayer(fake)));
  }),
);

it.effect("never takes an older message's late answer as the result of the latest", () =>
  Effect.gen(function* () {
    const fake = fakeGateway();
    yield* Effect.gen(function* () {
      const bots = yield* CirceBots;
      yield* bots.send({ botId: desk, messageId: messageId("m-a"), text: "First" });
      yield* bots.send({ botId: desk, messageId: messageId("m-b"), text: "Second" });
      const [first] = fake.prompts.map((prompt) => replyToken(prompt.prompt));
      assert.strictEqual(
        yield* bots.acceptReply({ token: first!, kind: "answer", text: "About the first." }),
        "accepted",
      );
      yield* bots.stopWaiting({ botId: desk, messageId: messageId("m-b") });
      const [place] = yield* bots.places();
      assert.include(place?.lastSent, { text: "Second", delivery: "expired" });
      assert.isNull(place?.lastReply ?? null);
    }).pipe(Effect.provide(botsLayer(fake)));
  }),
);

it.effect("keeps a stored conversation visible when the gateway stops listing its bot", () =>
  Effect.gen(function* () {
    const fake = fakeGateway();
    yield* Effect.gen(function* () {
      const bots = yield* CirceBots;
      yield* bots.send({ botId: desk, messageId: messageId("m-1"), text: "Hello" });
      fake.listFails = true;
      const down = yield* bots.refresh();
      assert.strictEqual(down.gateway.status, "unavailable");
      assert.deepStrictEqual(
        down.bots.map((summary) => [summary.bot.name, summary.listed]),
        [["Desk", false]],
      );
      const refused = yield* bots
        .send({ botId: desk, messageId: messageId("m-2"), text: "Again" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "gateway-unavailable");

      yield* bots.clearConversation(desk);
      const cleared = yield* bots.refresh();
      assert.deepStrictEqual(cleared.bots, []);
    }).pipe(Effect.provide(botsLayer(fake)));
  }),
);

it.effect("keeps an answer that lands before the gateway acknowledges the prompt", () =>
  Effect.gen(function* () {
    const fake = fakeGateway();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fake.sendGate = { entered, release };
    yield* Effect.gen(function* () {
      const bots = yield* CirceBots;
      // Hold send inside the gateway call so the callback can race the send.
      const sendFiber = yield* bots
        .send({ botId: desk, messageId: messageId("m-race"), text: "Race" })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => entered.promise);
      const prompt = fake.prompts[0];
      if (prompt === undefined) throw new Error("prompt never reached the gateway");
      const token = replyToken(prompt.prompt);

      // The bot answers before the gateway acknowledges the prompt.
      assert.strictEqual(
        yield* bots.acceptReply({ token, kind: "answer", text: "Early answer." }),
        "accepted",
      );

      release.resolve();
      const sent = yield* Fiber.join(sendFiber);

      // The landed answer must win; send must not reset it to 'waiting'.
      assert.strictEqual(sent.delivery, "answered");
      // The retained token still recognizes the identical retry as a duplicate.
      assert.strictEqual(
        yield* bots.acceptReply({ token, kind: "answer", text: "Early answer." }),
        "duplicate",
      );
    }).pipe(Effect.provide(botsLayer(fake)));
  }),
);
