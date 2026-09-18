import {
  AuthSessionId,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationV2Command,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "@effect/vitest";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import {
  CirceController,
  CirceControllerInterpreter,
  type CirceClassifiedTurn,
  type CirceControllerError,
} from "../Services/CirceController.ts";
import { CirceFollowUpDispatcher } from "../Services/CirceFollowUpDispatcher.ts";
import { CirceFollowUpQueue } from "../Services/CirceFollowUpQueue.ts";
import { CirceNodeTools } from "../Services/CirceNodeTools.ts";
import { CirceProjectLexicon } from "../Services/CirceProjectLexicon.ts";
import { CirceTaskDesk } from "../Services/CirceTaskDesk.ts";
import { makeCirceControllerLive } from "./CirceController.ts";

const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-beacon"),
  title: "Beacon",
  workspaceRoot: "/workspace/beacon",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const sessionId = AuthSessionId.make("controller-test-session");
const executionNodeId = EnvironmentId.make("node-controller-test");
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};

const codexProvider: ServerProvider = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-12T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      shortName: "Sol",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const thread = (id: ThreadId, title: string): OrchestrationThread => ({
  id,
  projectId: project.id,
  title,
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:01:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: id,
    status: "ready",
    providerName: "codex",
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: null,
    updatedAt: "2026-08-12T00:01:00.000Z",
  },
});

const testCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const testLexiconLayer = Layer.mock(CirceProjectLexicon)({
  list: () => Effect.succeed([]),
  learn: (input) =>
    Effect.succeed({ ...input, updatedAt: DateTime.makeUnsafe("2026-08-12T00:02:00.000Z") }),
  forget: () => Effect.succeed(false),
});

const testFollowUpQueueLayer = Layer.mock(CirceFollowUpQueue)({
  enqueue: () => Effect.void,
  claimNext: () => Effect.succeed(Option.none()),
  markDispatched: () => Effect.void,
  reconcileAccepted: () => Effect.void,
  release: () => Effect.void,
  resetRunning: () => Effect.void,
  statusOf: () => Effect.succeed(Option.none()),
  cancelPending: () => Effect.succeed(0),
  listPendingThreadIds: () => Effect.succeed([]),
  pendingCount: () => Effect.succeed(0),
});

const testFollowUpDispatcherLayer = Layer.mock(CirceFollowUpDispatcher)({
  start: () => Effect.void,
  reconcileThread: () => Effect.void,
  stop: () => Effect.succeed({ interrupted: false, cancelledFollowUps: 0 }),
  drain: Effect.void,
});

const emptyDesk = {
  focusedTask: null,
  recentTasks: [],
  pendingInteraction: null,
  updatedAt: null,
};

interface Harness {
  readonly layer: Layer.Layer<CirceController, CirceControllerError, never>;
  readonly commands: Array<OrchestrationV2Command>;
  readonly frames: Array<unknown>;
}

function program(turns: ReadonlyArray<CirceClassifiedTurn>) {
  let index = 0;
  return Layer.succeed(CirceControllerInterpreter, {
    interpret: () => Effect.die("interpret is not used by this test"),
    classify: () => {
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return turn === undefined ? Effect.die("no programmed classification") : Effect.succeed(turn);
    },
  });
}

function harness(input: {
  readonly turns: ReadonlyArray<CirceClassifiedTurn>;
  readonly details?: ReadonlyArray<OrchestrationThread>;
  readonly nodeTools?: {
    readonly available: ReadonlyArray<string>;
    readonly executors: import("@circe/core/controlDispatch").CirceNodeToolExecutors;
  };
}): Harness {
  const commands: Array<OrchestrationV2Command> = [];
  const frames: Array<unknown> = [];
  const details = new Map((input.details ?? []).map((entry) => [entry.id, entry]));
  const layer = makeCirceControllerLive(program(input.turns)).pipe(
    Layer.provideMerge(testFollowUpQueueLayer),
    Layer.provideMerge(testFollowUpDispatcherLayer),
    Layer.provideMerge(testLexiconLayer),
    Layer.provideMerge(
      Layer.succeed(CirceNodeTools, {
        available: input.nodeTools?.available ?? [],
        executors: input.nodeTools?.executors ?? {},
      }),
    ),
    Layer.provideMerge(
      ServerSettingsModule.ServerSettingsService.layerTest({
        circeDefaultModelSelection: modelSelection,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codexProvider]) }),
    ),
    Layer.provideMerge(
      Layer.mock(CirceTaskDesk)({
        get: () => Effect.succeed(emptyDesk),
        focus: () => Effect.succeed(emptyDesk),
        setPendingInteraction: ({ interaction }: { readonly interaction: unknown }) =>
          Effect.sync(() => {
            frames.push(interaction);
            return emptyDesk;
          }),
        consumePendingInteraction: () => Effect.succeed(null),
        clearPendingInteraction: () => Effect.succeed(emptyDesk),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: () => Effect.succeed(Option.some(project)),
        getThreadDetailById: (threadId: ThreadId) =>
          Effect.succeed(Option.fromNullishOr(details.get(threadId))),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [project],
            threads: [],
            updatedAt: "2026-08-12T00:02:00.000Z",
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(OrchestratorV2)({
        dispatch: (command: OrchestrationV2Command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length, storedEvents: [] };
          }),
        getThreadProjection: () => Effect.die("getThreadProjection is not used by this test"),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionTurnRepository)({
        getPendingTurnStartByThreadId: () => Effect.succeed(Option.none()),
      }),
    ),
    Layer.provideMerge(testCryptoLayer),
  );
  return { layer, commands, frames };
}

const execute = (layer: Harness["layer"], utterance: string) =>
  Effect.gen(function* () {
    const controller = yield* CirceController;
    return yield* controller.execute({
      sessionId,
      executionNodeId,
      utterance,
      projectId: project.id,
    });
  }).pipe(Effect.provide(layer));

const startTurn = (): CirceClassifiedTurn => {
  const command = {
    type: "start" as const,
    projectId: project.id,
    objective: "Implement device presence",
    modelSelection,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default" as const,
  };
  return {
    outcome: { kind: "work", commands: [command] },
    interpretation: { status: "command", command },
  };
};

describe("CirceController outcome dispatch", () => {
  it.effect("dispatches a work start through thread.create and message.dispatch", () => {
    const test = harness({ turns: [startTurn()] });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "implement device presence");
      expect(result.status).toBe("started");
      expect(test.commands.map((command) => command.type)).toEqual([
        "thread.create",
        "message.dispatch",
      ]);
      const dispatch = test.commands.find((command) => command.type === "message.dispatch");
      expect(dispatch).toMatchObject({
        type: "message.dispatch",
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      });
    });
  });

  it.effect("steers running work with the steer delivery intent", () => {
    const threadId = ThreadId.make("thread-running");
    const command = {
      type: "continue" as const,
      task: { threadId },
      instruction: "Use SQLite instead",
      mode: "steer" as const,
      taskSelection: "explicit" as const,
    };
    const test = harness({
      turns: [
        {
          outcome: { kind: "work", commands: [command] },
          interpretation: { status: "command", command },
        },
      ],
      details: [thread(threadId, "Running task")],
    });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "actually use SQLite instead");
      expect(result).toMatchObject({ status: "acknowledged", action: "steered" });
      expect(test.commands).toHaveLength(1);
      expect(test.commands[0]).toMatchObject({
        type: "message.dispatch",
        deliveryIntent: "steer",
      });
    });
  });

  it.effect("returns the acceptance speech for a client action without dispatching", () => {
    const turn: CirceClassifiedTurn = {
      outcome: {
        kind: "client-action",
        host: "client",
        tool: "open-website",
        risk: "mutating",
        args: { website: "YouTube" },
        speech: "Opening YouTube.",
      },
      interpretation: {
        status: "needs-input",
        reason: "unsupported-command",
        prompt: "unused",
        choices: [],
      },
    };
    const test = harness({ turns: [turn] });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "open YouTube");
      expect(result).toEqual({
        status: "acknowledged",
        action: "conversed",
        message: "Opening YouTube.",
      });
      expect(test.commands).toEqual([]);
    });
  });

  it.effect("runs a node tool through controlDispatch and speaks its result", () => {
    const turn: CirceClassifiedTurn = {
      outcome: {
        kind: "tool-answer",
        host: "node",
        tool: "weather",
        risk: "read-only",
        args: { location: "Paris", day: "now" },
      },
      interpretation: {
        status: "needs-input",
        reason: "unsupported-command",
        prompt: "unused",
        choices: [],
      },
    };
    const test = harness({
      turns: [turn],
      nodeTools: {
        available: ["weather"],
        executors: {
          weather: (request) =>
            Effect.succeed({
              status: "ok",
              speech: `Weather for ${String(request.args.location)}.`,
            }),
        },
      },
    });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "weather in Paris");
      expect(result).toEqual({
        status: "acknowledged",
        action: "conversed",
        message: "Weather for Paris.",
      });
    });
  });

  it.effect("reports a missing node executor as a wiring failure, not a refusal", () => {
    const turn: CirceClassifiedTurn = {
      outcome: {
        kind: "tool-answer",
        host: "node",
        tool: "time",
        risk: "read-only",
        args: { location: "Paris", day: "now" },
      },
      interpretation: {
        status: "needs-input",
        reason: "unsupported-command",
        prompt: "unused",
        choices: [],
      },
    };
    const test = harness({ turns: [turn] });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "time in Paris");
      expect(result).toMatchObject({
        status: "needs-input",
        prompt: "The time tool has no executor on this node.",
      });
    });
  });

  it.effect("returns a bounded inline conversation answer", () => {
    const command = {
      type: "converse" as const,
      instruction: "what is new",
      answer: "Nothing new today.",
    };
    const test = harness({
      turns: [
        {
          outcome: { kind: "conversation", answer: command.answer },
          interpretation: { status: "command", command },
        },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "what is new today");
      expect(result).toEqual({
        status: "acknowledged",
        action: "conversed",
        message: "Nothing new today.",
      });
      expect(test.commands).toEqual([]);
    });
  });

  it.effect("returns the explicit refusal for a refused outcome", () => {
    const turn: CirceClassifiedTurn = {
      outcome: { kind: "refused", reason: "classifier-declined" },
      interpretation: {
        status: "needs-input",
        reason: "unsupported-command",
        prompt: "Circe does one action per turn.",
        choices: [],
      },
    };
    const test = harness({ turns: [turn] });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "do everything");
      expect(result).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
      expect(test.commands).toEqual([]);
    });
  });

  it.effect("persists a durable typed frame for a project clarification", () => {
    const turn: CirceClassifiedTurn = {
      outcome: {
        kind: "clarification",
        clarification: {
          kind: "project",
          prompt: "Which project did you mean?",
          candidates: [{ projectId: project.id, label: "Beacon" }],
        },
      },
      interpretation: {
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Which project did you mean?",
        choices: ["Beacon"],
        projectClarification: { candidates: [{ projectId: project.id, label: "Beacon" }] },
      },
    };
    const test = harness({ turns: [turn] });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "check in that project");
      expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
      if (result.status === "needs-input") expect(result.clarificationFrameId).toBeDefined();
      expect(test.frames).toHaveLength(1);
      expect(test.commands).toEqual([]);
    });
  });

  it.effect("lists projects without dispatching provider work", () => {
    const command = { type: "list-projects" as const };
    const test = harness({
      turns: [
        {
          outcome: { kind: "work", commands: [command] },
          interpretation: { status: "command", command },
        },
      ],
    });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "what projects are there");
      expect(result).toMatchObject({ status: "acknowledged", action: "projects-listed" });
      expect(test.commands).toEqual([]);
    });
  });

  it.effect("reports the status of a task without dispatching", () => {
    const threadId = ThreadId.make("thread-status");
    const command = { type: "status" as const, task: { threadId } };
    const test = harness({
      turns: [
        {
          outcome: { kind: "work", commands: [command] },
          interpretation: { status: "command", command },
        },
      ],
      details: [thread(threadId, "Status task")],
    });
    return Effect.gen(function* () {
      const result = yield* execute(test.layer, "status of the task");
      expect(result).toMatchObject({ status: "acknowledged", action: "status", threadId });
      expect(test.commands).toEqual([]);
    });
  });

  it.effect("exposes the interpreter classify branch used by dispatch", () => {
    const turn = startTurn();
    return Effect.gen(function* () {
      const interpreter = yield* CirceControllerInterpreter;
      const classified = yield* interpreter.classify({
        utterance: "implement device presence",
        projects: [project],
        aliases: [],
        tasks: [],
        providers: [codexProvider],
        supervisorModelSelection: modelSelection,
        continueContext: false,
      });
      expect(classified.outcome.kind).toBe("work");
      expect(classified.interpretation).toEqual(turn.interpretation);
    }).pipe(Effect.provide(program([turn])));
  });
});
