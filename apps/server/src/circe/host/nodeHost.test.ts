import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CIRCE_CONVERSATIONS_PROJECT_TITLE,
  CirceBotError,
  ProjectId,
  type CirceBotId,
  type CirceBotSendInput,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectShell,
} from "@circe/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { layer as projectionLayer } from "../../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CirceBots, type CirceBotPlace, type CirceBotsShape } from "../Services/CirceBots.ts";
import { makeNodeHost } from "./nodeHost.ts";

/** Bots as the host reads them; tests change `places` to move the conversation along. */
interface FakeBots {
  places: CirceBotPlace[];
  sent: CirceBotSendInput[];
  delivery: "waiting" | "failed";
}

const fakeBots = (fake: FakeBots): CirceBotsShape =>
  ({
    places: () => Effect.succeed(fake.places),
    changes: Stream.empty,
    send: (input: CirceBotSendInput) =>
      Effect.sync(() => {
        fake.sent.push(input);
        return {
          role: "user" as const,
          messageId: input.messageId,
          botId: input.botId,
          text: input.text,
          createdAt: "2026-09-26T10:00:00.000Z",
          delivery: fake.delivery,
          error: fake.delivery === "failed" ? "Grok Bot rejected this message." : null,
          replyDeadlineAt: null,
        };
      }),
  }) as unknown as CirceBotsShape;

const noBots = (): FakeBots => ({ places: [], sent: [], delivery: "waiting" });

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process in this test"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const projectId = ProjectId.make("project:billing");

const withProject = (workspaceRoot: string, bots: CirceBotsShape = fakeBots(noBots())) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const project: OrchestrationProjectShell = {
      id: projectId,
      title: "Billing",
      workspaceRoot,
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    };
    return Layer.mergeAll(
      database,
      projectionLayer.pipe(Layer.provide(database)),
      makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "circe-node-host" },
        ProviderAdapterRegistry.makeLayer([adapter]),
        {
          databaseLayer: database,
          runEffectWorker: false,
        },
      ),
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShells: () =>
          Effect.succeed([
            project,
            {
              ...project,
              id: ProjectId.make("project:conversations"),
              title: CIRCE_CONVERSATIONS_PROJECT_TITLE,
              workspaceRoot: `${workspaceRoot}/conversations`,
            },
          ]),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
      }),
      ServerSettingsService.layerTest(),
      Layer.succeed(CirceBots, bots),
    );
  });

it.effect(
  "reads the node as Circe's world and carries Circe's operations out as orchestration commands",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "circe-node-host-" });
      yield* fs.writeFileString(
        path.join(root, "README.md"),
        "# Billing\n\nInvoices, taxes and payment webhooks for the shop.\n",
      );
      yield* fs.makeDirectory(path.join(root, "apps", "api"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "docs"));

      yield* Effect.gen(function* () {
        const host = yield* makeNodeHost;
        const empty = yield* Effect.promise(async () => host.state());
        assert.deepStrictEqual(empty.projects, [
          {
            id: projectId,
            name: "Billing",
            about: "Invoices, taxes and payment webhooks for the shop.",
            areas: ["apps/api", "docs"],
          },
          {
            id: ProjectId.make("project:conversations"),
            name: CIRCE_CONVERSATIONS_PROJECT_TITLE,
            about: "General questions and requests that are not about a coding project.",
            general: true,
          },
        ]);
        assert.deepStrictEqual(empty.threads, []);

        const threadId = yield* Effect.promise(() =>
          host.start(projectId, "Fix the rounding in invoice totals."),
        );
        const started = (yield* Effect.promise(async () => host.state())).threads;
        assert.equal(started.length, 1);
        assert.include(started[0], {
          id: threadId,
          projectId,
          title: "Fix the rounding in invoice totals",
          task: "Fix the rounding in invoice totals.",
        });

        yield* Effect.promise(() => host.close!(threadId));
        const closed = (yield* Effect.promise(async () => host.state())).threads;
        assert.include(closed[0], { id: threadId, archived: true });

        const failure = yield* Effect.promise(() =>
          host.stop("thread:missing").then(
            () => "",
            (error: Error) => error.message,
          ),
        );
        assert.equal(failure, "that thread no longer exists");
      }).pipe(Effect.provide(yield* withProject(root)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

const yt = "yt" as CirceBotId;
const ytBot = { botId: yt, name: "YT desk", description: "Video ideas for the channel" };

it.effect("puts Grok Bots in Circe's world and sends work for a bot to the bot", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "circe-node-host-bots-" });
    const bots: FakeBots = {
      places: [{ bot: ytBot, lastSent: null, lastReply: null }],
      sent: [],
      delivery: "waiting",
    };

    yield* Effect.gen(function* () {
      const host = yield* makeNodeHost;
      const world = yield* Effect.promise(async () => host.state());
      assert.deepInclude(world.projects, {
        id: "bot:yt",
        name: "YT desk",
        about: "A Grok Bot, not a codebase: Video ideas for the channel",
      });
      assert.deepInclude(world.threads[0], {
        id: "bot:yt",
        projectId: "bot:yt",
        title: "YT desk (Grok Bot)",
        runState: "idle",
      });

      // Starting work in the bot's place messages the bot; no thread is created.
      const threadId = yield* Effect.promise(() => host.start("bot:yt", "Three video ideas."));
      assert.equal(threadId, "bot:yt");
      yield* Effect.promise(() => host.deliver("bot:yt", "Make them shorter.", { mode: "steer" }));
      assert.deepStrictEqual(
        bots.sent.map((input) => [input.botId, input.text]),
        [
          ["yt", "Three video ideas."],
          ["yt", "Make them shorter."],
        ],
      );
      assert.equal(new Set(bots.sent.map((input) => input.messageId)).size, 2);

      bots.places = [
        {
          bot: ytBot,
          lastSent: {
            text: "Make them shorter.",
            at: "2026-09-26T10:00:00.000Z",
            delivery: "waiting",
            error: null,
          },
          lastReply: null,
        },
      ];
      const waiting = (yield* Effect.promise(async () => host.state())).threads[0];
      assert.include(waiting, { runState: "running", lastUserMessage: "Make them shorter." });

      const refusal = (operation: Promise<unknown>) =>
        Effect.promise(() =>
          operation.then(
            () => "",
            (error: Error) => error.message,
          ),
        );
      assert.include(yield* refusal(host.stop("bot:yt")), "stop it in Grok");
      assert.include(yield* refusal(host.respond("bot:yt", "request", "approve")), "Grok Bots");

      bots.delivery = "failed";
      assert.equal(
        yield* refusal(host.start("bot:yt", "Again.")),
        "Grok Bot rejected this message.",
      );
    }).pipe(Effect.provide(yield* withProject(root, fakeBots(bots))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps coding work in the world when the bot gateway fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "circe-node-host-bots-down-" });
    // The service would list a bot, but reading the bots fails.
    const failing = {
      ...fakeBots({
        places: [{ bot: ytBot, lastSent: null, lastReply: null }],
        sent: [],
        delivery: "waiting",
      }),
      places: () =>
        Effect.fail(
          new CirceBotError({
            code: "storage",
            message: "Circe could not save the bot conversation.",
          }),
        ),
    } as CirceBotsShape;
    yield* Effect.gen(function* () {
      const host = yield* makeNodeHost;
      const world = yield* Effect.promise(async () => host.state());
      assert.deepStrictEqual(
        world.projects.map((project) => project.name),
        ["Billing", CIRCE_CONVERSATIONS_PROJECT_TITLE],
      );
      assert.deepStrictEqual(world.threads, []);
    }).pipe(Effect.provide(yield* withProject(root, failing)));
  }).pipe(Effect.provide(NodeServices.layer)),
);
