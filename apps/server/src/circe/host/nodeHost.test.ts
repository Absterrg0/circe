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
  RunId,
  ThreadId,
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
import {
  CirceComputerAccess,
  CirceComputerAccessError,
  type CirceComputerAccessShape,
  type CirceComputerAccessState,
  type CirceComputerDecisionSource,
  type CirceComputerRequester,
} from "../Services/CirceComputerAccess.ts";
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

/** Computer access as the host sees it; `calls` records what the host asked for. */
interface FakeComputer {
  controllable: boolean;
  state: CirceComputerAccessState;
  calls: string[];
  refusal?: string;
}

const fakeComputer = (fake: FakeComputer): CirceComputerAccessShape =>
  ({
    get controllable() {
      return fake.controllable;
    },
    state: Effect.sync(() => fake.state),
    request: (input: { readonly goal: string; readonly requester: CirceComputerRequester }) =>
      fake.refusal === undefined
        ? Effect.sync(() => {
            const origin = input.requester.kind === "user" ? input.requester.origin : "agent";
            fake.calls.push(`request ${input.goal} from ${origin}`);
            const request = {
              id: `request-${fake.calls.length}`,
              goal: input.goal,
              requester: input.requester,
              at: "2026-09-26T10:00:00.000Z",
              cancelId: null,
            };
            fake.state = { ...fake.state, pending: request };
            return request;
          })
        : Effect.fail(new CirceComputerAccessError({ reason: fake.refusal })),
    decide: (requestId: string, decision: string, source: CirceComputerDecisionSource) =>
      Effect.sync(
        () =>
          void fake.calls.push(
            `${decision} ${requestId} ${source.kind === "spoken" ? `from ${source.origin}` : "explicitly"}`,
          ),
      ),
    stop: (requestId?: string) =>
      Effect.sync(() => {
        fake.calls.push(`stop ${requestId ?? "all"}`);
        return true;
      }),
    changes: Stream.empty,
  }) as unknown as CirceComputerAccessShape;

const noComputer = (): FakeComputer => ({
  controllable: false,
  state: { pending: null, active: null, last: null },
  calls: [],
});

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

const withProject = (
  workspaceRoot: string,
  bots: CirceBotsShape = fakeBots(noBots()),
  computer: CirceComputerAccessShape = fakeComputer(noComputer()),
) =>
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
      Layer.succeed(CirceComputerAccess, computer),
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
        const host = yield* makeNodeHost();
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
            kind: "general",
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
      const host = yield* makeNodeHost();
      const world = yield* Effect.promise(async () => host.state());
      assert.deepInclude(world.projects, {
        id: "bot:yt",
        name: "YT desk",
        about: "A Grok Bot, not a codebase: Video ideas for the channel",
      });
      assert.deepInclude(world.threads[0], {
        id: "botchat:0:yt",
        projectId: "bot:yt",
        title: "YT desk (Grok Bot)",
        runState: "idle",
      });

      // Starting work in the bot's place messages the bot as a new
      // conversation thread, which is what circe-core watches for the answer.
      const threadId = yield* Effect.promise(() => host.start("bot:yt", "Three video ideas."));
      assert.equal(threadId, "botchat:1:yt");
      assert.equal(
        (yield* Effect.promise(async () => host.state())).threads[0]?.id,
        "botchat:1:yt",
      );
      yield* Effect.promise(() => host.deliver(threadId, "Make them shorter.", { mode: "steer" }));
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
      assert.include(yield* refusal(host.stop(threadId)), "stop it in Grok");
      assert.include(yield* refusal(host.respond(threadId, "request", "approve")), "Grok Bots");
      // Undoing the start reaches the host, which says it cannot take it back.
      assert.include(yield* refusal(host.close!(threadId)), "can't be closed");

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
      const host = yield* makeNodeHost();
      const world = yield* Effect.promise(async () => host.state());
      assert.deepStrictEqual(
        world.projects.map((project) => project.name),
        ["Billing", CIRCE_CONVERSATIONS_PROJECT_TITLE],
      );
      assert.deepStrictEqual(world.threads, []);
    }).pipe(Effect.provide(yield* withProject(root, failing)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("puts this computer in Circe's world and asks before using it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "circe-node-host-computer-" });
    const computer: FakeComputer = { ...noComputer(), controllable: true };
    let origin: string | null = "desk";
    let turnPending: string | null | undefined = undefined;

    yield* Effect.gen(function* () {
      const host = yield* makeNodeHost({ turnOrigin: () => origin });
      const world = yield* Effect.promise(async () => host.state());
      assert.include(
        world.projects.find((project) => project.id === "computer:this"),
        { name: "This computer" },
      );
      // Nothing asked yet: the place exists with no request in it.
      assert.isFalse(world.threads.some((thread) => thread.projectId === "computer:this"));

      // "Open the browser" becomes its own request thread, waiting on a
      // question rather than an approval, so no standing rule can answer it.
      const threadId = yield* Effect.promise(() => host.start("computer:this", "Open the browser"));
      assert.equal(threadId, "computer:request:request-1");
      const asked = (yield* Effect.promise(async () => host.state())).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepStrictEqual(asked?.pending, {
        id: "request-1",
        kind: "question",
        text: 'Use this computer for "Open the browser"? Say yes to start.',
      });

      // Anything but a plain yes or no is a new goal with its own question.
      yield* Effect.promise(() =>
        host.deliver(threadId, "actually open the settings", {
          mode: "reply",
          requestId: "request-1",
        }),
      );
      const corrected = "computer:request:request-2";
      yield* Effect.promise(() =>
        host.deliver(corrected, "yes", { mode: "reply", requestId: "request-2" }),
      );
      origin = "phone";
      yield* Effect.promise(() =>
        host.deliver(corrected, "no", { mode: "reply", requestId: "request-2" }),
      );
      yield* Effect.promise(() => host.stop(corrected));
      // Undo from another device is refused; the device that asked can undo it.
      const undoElsewhere = yield* Effect.promise(() =>
        host.close!(corrected).then(
          () => "",
          (error: Error) => error.message,
        ),
      );
      assert.include(undoElsewhere, "another device");
      origin = "desk";
      yield* Effect.promise(() => host.close!(corrected));
      assert.deepStrictEqual(computer.calls, [
        "request Open the browser from desk",
        "request actually open the settings from desk",
        "approve request-2 from desk",
        "deny request-2 from phone",
        "stop request-2",
        "stop request-2",
      ]);

      computer.refusal = "Computer use needs the Circe desktop app running on this node.";
      const refused = yield* Effect.promise(() =>
        host.start("computer:this", "Open the calculator").then(
          () => "",
          (error: Error) => error.message,
        ),
      );
      assert.equal(refused, computer.refusal);
    }).pipe(Effect.provide(yield* withProject(root, undefined, fakeComputer(computer))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("leaves the computer out of the world on a node without a desktop", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "circe-node-host-headless-" });
    yield* Effect.gen(function* () {
      const host = yield* makeNodeHost();
      const world = yield* Effect.promise(async () => host.state());
      assert.isFalse(world.projects.some((project) => project.id === "computer:this"));
      assert.isFalse(world.threads.some((thread) => thread.id === "computer:this"));
    }).pipe(Effect.provide(yield* withProject(root)));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("holds work started this turn as running, and refuses undo from another device", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "circe-node-host-turn-" });
    // The bot answers before the turn ends.
    const bots: FakeBots = {
      places: [
        {
          bot: ytBot,
          lastSent: {
            text: "Ideas",
            at: "2026-09-26T10:00:00.000Z",
            delivery: "answered",
            error: null,
          },
          lastReply: { text: "Three ideas.", at: "2026-09-26T10:00:01.000Z", outcome: "answer" },
        },
      ],
      sent: [],
      delivery: "waiting",
    };
    const heldThisTurn = new Set<string>();
    let origin: string | null = "desk";
    let turn = { phase: "turn" as "turn" | "own" | "open", turn: 1 };
    yield* Effect.gen(function* () {
      const host = yield* makeNodeHost({
        turnOrigin: () => origin,
        heldThisTurn,
        turnPhase: () => turn,
      });
      yield* Effect.promise(async () => host.state());
      const threadId = yield* Effect.promise(() => host.start("bot:yt", "Ideas"));
      const during = (yield* Effect.promise(async () => host.state())).threads[0];
      assert.include(during, { id: threadId, runState: "running" });
      // Once the turn is over the answer is a change circe-core can announce.
      turn = { phase: "own", turn: 1 };
      const after = (yield* Effect.promise(async () => host.state())).threads[0];
      assert.include(after, { id: threadId, runState: "idle" });
      heldThisTurn.clear();
      turn = { phase: "open", turn: 1 };

      // A follow-up the bot answers before delivery returns is held the same way.
      turn = { phase: "turn", turn: 2 };
      yield* Effect.promise(async () => host.state());
      yield* Effect.promise(() => host.deliver(threadId, "More", { mode: "send" }));
      assert.include((yield* Effect.promise(async () => host.state())).threads[0], {
        runState: "running",
      });
      heldThisTurn.clear();
      turn = { phase: "open", turn: 2 };

      origin = "phone";
      const refused = yield* Effect.promise(() =>
        host.close!(threadId).then(
          () => "",
          (error: Error) => error.message,
        ),
      );
      assert.include(refused, "another device");
    }).pipe(Effect.provide(yield* withProject(root, fakeBots(bots))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("freezes what the turn did not touch until the turn is over", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "circe-node-host-freeze-" });
    const agentAsk = {
      id: "agent-ask",
      goal: "check the page",
      requester: {
        kind: "agent" as const,
        threadId: ThreadId.make("thread-ui"),
        runId: RunId.make("run-1"),
        providerSessionId: "session-ui",
        title: "Fix the page",
      },
      at: "2026-09-26T10:00:00.000Z",
      cancelId: null,
    };
    const computer: FakeComputer = { ...noComputer(), controllable: true };
    const bots: FakeBots = {
      places: [{ bot: ytBot, lastSent: null, lastReply: null }],
      sent: [],
      delivery: "waiting",
    };
    let turn = { phase: "turn" as "turn" | "own" | "open", turn: 1 };
    yield* Effect.gen(function* () {
      const host = yield* makeNodeHost({ heldThisTurn: new Set(), turnPhase: () => turn });
      const before = yield* Effect.promise(async () => host.state());
      assert.include(before.threads[0], { id: "botchat:0:yt", runState: "idle" });

      // Mid-turn, someone else's bot starts waiting and an agent asks for the computer.
      bots.places = [
        {
          bot: ytBot,
          lastSent: {
            text: "Hi",
            at: "2026-09-26T10:00:00.000Z",
            delivery: "waiting",
            error: null,
          },
          lastReply: null,
        },
      ];
      computer.state = { ...computer.state, pending: agentAsk };
      const during = yield* Effect.promise(async () => host.state());
      assert.include(during.threads[0], { id: "botchat:0:yt", runState: "idle" });
      assert.isFalse(during.threads.some((thread) => thread.id === "computer:request:agent-ask"));
      turn = { phase: "own", turn: 1 };
      const own = yield* Effect.promise(async () => host.state());
      assert.include(own.threads[0], { runState: "idle" });

      // Opened up, both are changes circe-core sees and announces.
      turn = { phase: "open", turn: 1 };
      const after = yield* Effect.promise(async () => host.state());
      assert.include(
        after.threads.find((thread) => thread.id === "botchat:0:yt"),
        { runState: "running" },
      );
      assert.include(
        after.threads.find((thread) => thread.id === "computer:request:agent-ask")?.pending,
        { kind: "question" },
      );
    }).pipe(Effect.provide(yield* withProject(root, fakeBots(bots), fakeComputer(computer))));
  }).pipe(Effect.provide(NodeServices.layer)),
);
