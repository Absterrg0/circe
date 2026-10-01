// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type CirceLookupDay, type CirceSemanticProposal } from "@circe/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ComputerService } from "../../computer/ComputerService.ts";
import * as CirceController from "../Services/CirceController.ts";
import { CirceBrowserUse } from "../Services/CirceBrowserUse.ts";
import { CirceBrowserConnector } from "../Services/CirceBrowserConnector.ts";
import { CirceBrowserConnectorUse } from "../Services/CirceBrowserConnectorUse.ts";
import { CirceComputerAccess } from "../Services/CirceComputerAccess.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { CirceInteraction } from "../Services/CirceInteraction.ts";
import { CirceMissionCancellationLive } from "./CirceMissionCancellation.ts";
import { make, type CirceInteractionOptions } from "./CirceInteraction.ts";

const nodeId = EnvironmentId.make("node-one");

const weatherQuestion: CirceSemanticProposal = {
  action: "unsupported",
  refs: [],
  model: null,
  effort: null,
  answer: null,
  clarification: { kind: "lookup", prompt: "Which city or place?", tool: "weather", day: "now" },
};
const weatherProposal: CirceSemanticProposal = {
  action: "lookup",
  refs: [],
  model: null,
  effort: null,
  answer: null,
  lookup: { kind: "weather", location: "Ahmedabad", day: "now" },
};

const converseProposal: CirceSemanticProposal = {
  action: "converse",
  refs: [],
  model: null,
  effort: null,
  answer: null,
};
const defaultClassify: NonNullable<CirceInteractionOptions["classify"]> = (source) =>
  Effect.succeed(source.includes("weather") ? weatherQuestion : converseProposal);

const defaultLookup: NonNullable<CirceInteractionOptions["lookup"]> = (goal, source) =>
  Effect.succeed({
    status: "answer" as const,
    message: `${source}: 31°C, clear skies.`,
    source: "https://open-meteo.com/",
    location: source,
    day: goal.day as CirceLookupDay,
  });

const baseConfigLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);

const configLayer = (preset: "full" | "controller" | "headless") =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return ServerConfig.ServerConfig.of({ ...config, circeNodePreset: preset });
    }).pipe(Effect.provide(baseConfigLayer)),
  );

interface MissionRecorder {
  readonly connectorConnected?: boolean;
  readonly preset?: "full" | "controller" | "headless";
  readonly desktopReady?: boolean;
  readonly onConnectorRun?: () => void;
  readonly onComputerRun?: () => void;
  /** Async mission body, used to hold a mission open while a test inspects it. */
  readonly computerRun?: () => Effect.Effect<void>;
  readonly connectorRun?: () => Effect.Effect<void>;
  /** One running task the node's shell reports, for stop resolution. */
  readonly runningTask?: {
    readonly threadId: string;
    readonly projectId: string;
    readonly title: string;
  };
  readonly onControllerExecute?: (input: unknown) => void;
}

const desktopRun = (recorder: MissionRecorder) =>
  Effect.sync(() => recorder.onComputerRun?.()).pipe(
    Effect.andThen(recorder.computerRun?.() ?? Effect.void),
    Effect.as({ status: "done" as const, message: "Done: desktop goal", steps: 3 }),
  );

const supportLayer = (recorder: MissionRecorder = {}) =>
  Layer.mergeAll(
    CirceMissionCancellationLive,
    Layer.succeed(
      CirceBrowserUse,
      CirceBrowserUse.of({
        run: () =>
          Effect.succeed({ status: "done" as const, message: "Done: browser goal", steps: 2 }),
      }),
    ),
    Layer.succeed(
      CirceComputerUse,
      CirceComputerUse.of({
        run: () => desktopRun(recorder),
        runInMission: () => desktopRun(recorder),
        wholeGoals: true,
      }),
    ),
    // The computer's owner as this route sees it: an approved run reaches the
    // same desktop executor.
    Layer.mock(CirceComputerAccess)({
      controllable: true,
      run: () => desktopRun(recorder),
    }),
    Layer.succeed(
      CirceBrowserConnector,
      CirceBrowserConnector.of({
        status: (profileLabel?: string) =>
          Effect.succeed(
            recorder.connectorConnected === true
              ? { connected: true, profileLabel: profileLabel ?? "Default" }
              : { connected: false },
          ),
        listTabs: () => Effect.succeed([]),
        attach: () => Effect.die("unused"),
        snapshot: () => Effect.die("unused"),
        apply: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      CirceBrowserConnectorUse,
      CirceBrowserConnectorUse.of({
        run: () =>
          Effect.sync(() => recorder.onConnectorRun?.()).pipe(
            Effect.andThen(recorder.connectorRun?.() ?? Effect.void),
            Effect.as({ status: "done" as const, message: "Done: browser goal", steps: 2 }),
          ),
      }),
    ),
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(nodeId),
        getDescriptor: Effect.die("unused"),
        setLabel: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [],
            threads:
              recorder.runningTask === undefined
                ? []
                : [
                    {
                      id: recorder.runningTask.threadId,
                      projectId: recorder.runningTask.projectId,
                      title: recorder.runningTask.title,
                      session: { status: "running" },
                      updatedAt: "2026-09-20T12:00:00.000Z",
                    },
                  ],
            updatedAt: "2026-09-20T12:00:00.000Z",
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    ...(recorder.onControllerExecute === undefined
      ? []
      : [
          Layer.succeed(
            CirceController.CirceController,
            CirceController.CirceController.of({
              execute: (input: unknown) =>
                Effect.sync(() => recorder.onControllerExecute?.(input)).pipe(
                  Effect.as({
                    status: "acknowledged" as const,
                    action: "interrupted" as const,
                    threadId: "thread-running",
                    projectId: "project-running",
                    message: "Long task is stopping.",
                  }),
                ),
              interpret: () => Effect.die("unused"),
              converse: () => Effect.die("unused"),
              cancelRequest: () => Effect.succeed({ status: "unknown" as const, requestId: "x" }),
              warmSupervisor: () => Effect.void,
            } as unknown as CirceController.CirceControllerShape),
          ),
        ]),
    Layer.mock(ComputerService)({
      status: Effect.succeed({
        available: recorder.desktopReady === true,
        host:
          recorder.desktopReady === true
            ? {
                available: true,
                platform: "linux" as const,
                runtime: "ready" as const,
                capabilities: {
                  observe: true,
                  capture: true,
                  pointer: true,
                  keyboard: true,
                  windows: true,
                  browser: false,
                  nativeGrounding: true,
                  visualGrounding: false,
                },
              }
            : undefined,
        activeMission: undefined,
      }),
    }),
    configLayer(recorder.preset ?? "full"),
  );

const interactionLayer = (options: CirceInteractionOptions = {}, recorder: MissionRecorder = {}) =>
  Layer.effect(
    CirceInteraction,
    make({
      classify: options.classify ?? defaultClassify,
      lookup: options.lookup ?? defaultLookup,
      ...(options.findRunningTask === undefined
        ? {}
        : { findRunningTask: options.findRunningTask }),
    }),
  ).pipe(Layer.provideMerge(supportLayer(recorder)));

const withMemoryAt = <A, E>(
  tempDir: string,
  options: CirceInteractionOptions,
  use: (layer: Layer.Layer<CirceInteraction, never, never>) => Effect.Effect<A, E, Scope.Scope>,
  recorder: MissionRecorder = {},
) =>
  Effect.gen(function* () {
    const layer = interactionLayer(options, recorder).pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"))),
      Layer.provideMerge(NodeServices.layer),
      Layer.orDie,
    );
    // The layer instance lives exactly as long as the use callback, so a
    // forked mission is interrupted when the caller returns: that is how the
    // reconcile test simulates a process that died mid-mission.
    return yield* Effect.scoped(use(layer));
  });

const withMemory = <A, E>(
  options: CirceInteractionOptions,
  use: (layer: Layer.Layer<CirceInteraction, never, never>) => Effect.Effect<A, E, Scope.Scope>,
  recorder: MissionRecorder = {},
) =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-interaction-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    return yield* withMemoryAt(tempDir, options, use, recorder);
  });

const computerProposal: CirceSemanticProposal = {
  action: "computer",
  refs: [],
  model: null,
  effort: null,
  answer: null,
  computerGoal: "click the 7 button",
};

const submitInput = (
  requestId: string,
  utterance: string,
  extra: {
    readonly interactionId?: string;
    readonly expectedRevision?: number;
  } = {},
) =>
  ({
    requestId,
    utterance,
    executionNodeId: nodeId,
    ...(extra.interactionId === undefined ? {} : { interactionId: extra.interactionId }),
    ...(extra.expectedRevision === undefined ? {} : { expectedRevision: extra.expectedRevision }),
  }) as never;

it.effect("answers a weather question, then resumes the same lookup from a bare place", () =>
  withMemory({}, (layer) =>
    Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
      assert.strictEqual(first.status, "question");
      if (first.status !== "question") return;
      assert.strictEqual(first.state.goal.kind, "lookup");
      assert.strictEqual(first.state.pending?.slot, "location");
      assert.strictEqual(first.state.revision, 0);

      const second = yield* interaction.submit(
        submitInput("req-2", "Ahmedabad", {
          interactionId: first.state.interactionId,
          expectedRevision: first.state.revision,
        }),
      );
      assert.strictEqual(second.status, "answered");
      if (second.status !== "answered") return;
      assert.strictEqual(second.state.pending, null);
      // Revision 1 consumes the answer; revision 2 records its result.
      assert.strictEqual(second.state.revision, 2);
      assert.deepStrictEqual(second.state.goal, {
        kind: "lookup",
        tool: "weather",
        day: "now",
        location: "Ahmedabad",
      });
      assert.match(second.message, /Ahmedabad/);
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("answers a lookup that already names a place without asking", () =>
  withMemory(
    {
      classify: () => Effect.succeed(weatherProposal),
      lookup: (goal) =>
        Effect.succeed({
          status: "answer" as const,
          message: "Ahmedabad: 31°C, clear skies.",
          source: "https://open-meteo.com/",
          location: "Ahmedabad",
          day: goal.day,
        }),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const first = yield* interaction.submit(submitInput("req-1", "weather in Ahmedabad"));
        assert.strictEqual(first.status, "answered");
        if (first.status !== "answered" || first.state.goal.kind !== "lookup") return;
        assert.strictEqual(first.state.pending, null);
        assert.strictEqual(first.state.goal.location, "Ahmedabad");
        assert.strictEqual(first.state.revision, 1);
      }).pipe(Effect.provide(layer)),
  ),
);

it.effect("prefers the browser connector over desktop control for a browser mission", () => {
  let connectorRuns = 0;
  let computerRuns = 0;
  return withMemory(
    {
      classify: () =>
        Effect.succeed({
          action: "browse" as const,
          refs: [],
          model: null,
          effort: null,
          answer: null,
          browserGoal: "open youtube and search for tanmay bhat",
        }),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const result = yield* interaction.submit(
          submitInput("req-connector", "open youtube and search for tanmay bhat in my browser"),
        );
        assert.strictEqual(result.status, "operation");
        assert.strictEqual(connectorRuns, 1);
        assert.strictEqual(computerRuns, 0);
      }).pipe(Effect.provide(layer)),
    {
      connectorConnected: true,
      onConnectorRun: () => {
        connectorRuns += 1;
      },
      onComputerRun: () => {
        computerRuns += 1;
      },
    },
  );
});

it.effect("refuses a browser mission on a Headless node even with the extension connected", () => {
  let connectorRuns = 0;
  return withMemory(
    {
      classify: () =>
        Effect.succeed({
          action: "browse" as const,
          refs: [],
          model: null,
          effort: null,
          answer: null,
          browserGoal: "open youtube",
        }),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const readiness = yield* interaction.readiness();
        assert.isFalse(readiness.surfaces.find((entry) => entry.surface === "browser")?.ready);
        const result = yield* interaction.submit(submitInput("req-headless", "open youtube"));
        assert.strictEqual(result.status, "unavailable");
        assert.strictEqual(connectorRuns, 0);
      }).pipe(Effect.provide(layer)),
    {
      preset: "headless",
      connectorConnected: true,
      onConnectorRun: () => {
        connectorRuns += 1;
      },
    },
  );
});

it.effect("falls back to desktop control when no browser connector is attached", () => {
  let connectorRuns = 0;
  let computerRuns = 0;
  return withMemory(
    {
      classify: () =>
        Effect.succeed({
          action: "browse" as const,
          refs: [],
          model: null,
          effort: null,
          answer: null,
          browserGoal: "open youtube and search for tanmay bhat",
        }),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const result = yield* interaction.submit(
          submitInput("req-fallback", "open youtube and search for tanmay bhat in my browser"),
        );
        assert.strictEqual(result.status, "operation");
        assert.strictEqual(connectorRuns, 0);
        assert.strictEqual(computerRuns, 1);
      }).pipe(Effect.provide(layer)),
    {
      desktopReady: true,
      onConnectorRun: () => {
        connectorRuns += 1;
      },
      onComputerRun: () => {
        computerRuns += 1;
      },
    },
  );
});

it.effect("treats an action-lookup proposal carrying a clarification as a lookup question", () =>
  withMemory(
    {
      classify: () =>
        Effect.succeed({
          action: "lookup",
          refs: [],
          model: null,
          effort: null,
          answer: null,
          clarification: {
            kind: "lookup",
            prompt: "Which location should I check the weather for?",
            tool: "weather",
            day: "now",
          },
        } as CirceSemanticProposal),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const result = yield* interaction.submit(submitInput("req-clarify", "check the weather"));
        assert.strictEqual(result.status, "question");
        if (result.status !== "question" || result.state.goal.kind !== "lookup") return;
        assert.strictEqual(result.state.pending?.slot, "location");
      }).pipe(Effect.provide(layer)),
  ),
);

it.effect("retargets a bare place after an answer instead of starting new work", () => {
  const seen: Array<{ location: string; source: string }> = [];
  return withMemory(
    {
      classify: () =>
        Effect.succeed({
          action: "lookup",
          refs: [],
          model: null,
          effort: null,
          answer: null,
          clarification: {
            kind: "lookup",
            prompt: "Which location?",
            tool: "weather",
            day: "now",
          },
        } as CirceSemanticProposal),
      lookup: (goal, source) => {
        seen.push({ location: goal.location ?? "", source });
        return Effect.succeed({
          status: "answer" as const,
          message: `${goal.location}: 31°C.`,
          source: "https://open-meteo.com/",
          location: goal.location ?? "",
          day: goal.day,
        });
      },
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
        if (first.status !== "question") return;
        const answered = yield* interaction.submit(
          submitInput("req-2", "Ahmedabad", {
            interactionId: first.state.interactionId,
            expectedRevision: first.state.revision,
          }),
        );
        assert.strictEqual(answered.status, "answered");
        if (answered.status !== "answered") return;
        const retargeted = yield* interaction.submit(
          submitInput("req-3", "Springfield, Illinois", {
            interactionId: answered.state.interactionId,
            expectedRevision: answered.state.revision,
          }),
        );
        assert.strictEqual(retargeted.status, "answered");
        if (retargeted.status !== "answered" || retargeted.state.goal.kind !== "lookup") return;
        // The extracted span keeps the user's words without punctuation; the
        // lookup runner still splits the region for geocoding.
        assert.strictEqual(retargeted.state.goal.location, "Springfield Illinois");
        assert.deepStrictEqual(
          seen.map((entry) => entry.location),
          ["Ahmedabad", "Springfield Illinois"],
        );
      }).pipe(Effect.provide(layer)),
  );
});

it.effect("grounds a corrected lookup against the place the user already gave", () => {
  const seen: Array<string> = [];
  return withMemory(
    {
      classify: () =>
        Effect.succeed({
          action: "lookup",
          refs: [],
          model: null,
          effort: null,
          answer: null,
          clarification: {
            kind: "lookup",
            prompt: "Which location?",
            tool: "weather",
            day: "now",
          },
        } as CirceSemanticProposal),
      lookup: (goal, source) => {
        seen.push(source);
        return Effect.succeed({
          status: "answer" as const,
          message: `${goal.location}: 31°C.`,
          source: "https://open-meteo.com/",
          location: goal.location ?? "",
          day: goal.day,
        });
      },
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
        if (first.status !== "question") return;
        const answer = yield* interaction.submit(
          submitInput("req-2", "Ahmedabad", {
            interactionId: first.state.interactionId,
            expectedRevision: first.state.revision,
          }),
        );
        assert.strictEqual(answer.status, "answered");
        if (answer.status !== "answered") return;
        const correction = yield* interaction.submit(
          submitInput("req-3", "actually tomorrow", {
            interactionId: answer.state.interactionId,
            expectedRevision: answer.state.revision,
          }),
        );
        assert.strictEqual(correction.status, "answered");
        // The runner must be able to ground the retained place in the source
        // it is given, even though the correction never repeated it.
        assert.deepStrictEqual(seen, ["Ahmedabad", "Ahmedabad. actually tomorrow"]);
      }).pipe(Effect.provide(layer)),
  );
});

it.effect("delegates a stop for a coding goal so the client can interrupt the task", () =>
  withMemory(
    {
      classify: () => Effect.succeed(converseProposal),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const started = yield* interaction.submit(submitInput("req-1", "what's on my plate"));
        assert.strictEqual(started.status, "delegated");
        if (started.status !== "delegated") return;
        assert.strictEqual(started.state.goal.kind, "conversation");
        // Conversation cancels outright; coding delegates a stop.
        const cancelled = yield* interaction.submit(
          submitInput("req-2", "stop", {
            interactionId: started.state.interactionId,
            expectedRevision: started.state.revision,
          }),
        );
        assert.strictEqual(cancelled.status, "cancelled");
      }).pipe(Effect.provide(layer)),
  ),
);

it.effect("reports nothing running when a coding stop finds no running task", () =>
  withMemory(
    {
      classify: () =>
        Effect.succeed({
          action: "start",
          refs: [],
          model: null,
          effort: null,
          answer: null,
        } as CirceSemanticProposal),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const started = yield* interaction.submit(submitInput("req-1", "fix the parser"));
        assert.strictEqual(started.status, "delegated");
        if (started.status !== "delegated") return;
        assert.strictEqual(started.state.goal.kind, "coding");
        const stopped = yield* interaction.submit(
          submitInput("req-2", "stop", {
            interactionId: started.state.interactionId,
            expectedRevision: started.state.revision,
          }),
        );
        assert.strictEqual(stopped.status, "cancelled");
        if (stopped.status !== "cancelled") return;
        assert.strictEqual(stopped.state.outcome?.message, "Nothing is running on this node.");
      }).pipe(Effect.provide(layer)),
  ),
);

it.effect("interrupts the task the node is actually running when stop is spoken", () => {
  const executed: Array<{ referenceThreadId?: string; semanticProposal?: { action: string } }> = [];
  return withMemory(
    {
      classify: () =>
        Effect.succeed({
          action: "start",
          refs: [],
          model: null,
          effort: null,
          answer: null,
        } as CirceSemanticProposal),
      findRunningTask: () =>
        Effect.succeed({
          threadId: "thread-running" as never,
          projectId: "project-running" as never,
          title: "Long task",
        }),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const started = yield* interaction.submit(submitInput("req-1", "fix the parser"));
        if (started.status !== "delegated") return;
        const stopped = yield* interaction.submit({
          requestId: "req-2",
          utterance: "stop",
          executionNodeId: nodeId,
          interactionId: started.state.interactionId,
          expectedRevision: started.state.revision,
          sessionId: "session-one",
        } as never);
        assert.strictEqual(stopped.status, "cancelled");
        assert.strictEqual(executed.length, 1);
        // The stop targets the running thread, not the focused one.
        assert.strictEqual(executed[0]?.referenceThreadId, "thread-running");
        assert.strictEqual(executed[0]?.semanticProposal?.action, "stop");
      }).pipe(Effect.provide(layer)),
    {
      onControllerExecute: (input) => executed.push(input as never),
    },
  );
});

it.effect("rejects a second device answering the same revision", () =>
  withMemory({}, (layer) =>
    Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
      if (first.status !== "question") return;
      const answer = (requestId: string, utterance: string) =>
        interaction.submit(
          submitInput(requestId, utterance, {
            interactionId: first.state.interactionId,
            expectedRevision: first.state.revision,
          }),
        );
      const winner = yield* answer("req-2", "Ahmedabad");
      assert.strictEqual(winner.status, "answered");
      const loser = yield* answer("req-3", "London");
      assert.strictEqual(loser.status, "stale");
      if (loser.status !== "stale" || loser.state.goal.kind !== "lookup") return;
      assert.strictEqual(loser.state.goal.location, "Ahmedabad");
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("replays a submission by request id without running it twice", () =>
  withMemory({}, (layer) =>
    Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
      if (first.status !== "question") return;
      const input = submitInput("req-2", "Ahmedabad", {
        interactionId: first.state.interactionId,
        expectedRevision: first.state.revision,
      });
      const once = yield* interaction.submit(input);
      const twice = yield* interaction.submit(input);
      assert.deepStrictEqual(twice, once);
      const read = yield* interaction.read({
        executionNodeId: nodeId,
        interactionId: first.state.interactionId,
      });
      assert.strictEqual(read?.revision, 2);
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("retires a stale question when the user starts new work", () =>
  withMemory({}, (layer) =>
    Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
      if (first.status !== "question") return;
      const next = yield* interaction.submit(
        submitInput("req-2", "what's on my plate", {
          interactionId: first.state.interactionId,
          expectedRevision: first.state.revision,
        }),
      );
      assert.strictEqual(next.status, "delegated");
      if (next.status !== "delegated") return;
      assert.strictEqual(next.state.pending, null);
      assert.strictEqual(next.state.goal.kind, "conversation");
      // Retiring the question and replacing the goal are two transitions.
      assert.strictEqual(next.state.revision, 2);
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("cancels a pending question and reports a confirmed stop", () =>
  withMemory({}, (layer) =>
    Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
      if (first.status !== "question") return;
      const stopped = yield* interaction.interrupt({
        interactionId: first.state.interactionId,
        requestId: "stop-1",
        executionNodeId: nodeId,
      });
      assert.strictEqual(stopped.stopRequested, true);
      assert.strictEqual(stopped.stopConfirmed, true);
      assert.strictEqual(stopped.state.pending, null);
      assert.strictEqual(stopped.state.outcome?.status, "stopped");
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("turns an ambiguous place into a choice question and binds the offered answer", () =>
  withMemory(
    {
      lookup: (_goal, source) =>
        source.includes("Springfield") && !source.includes(",")
          ? Effect.succeed({
              status: "question" as const,
              slot: "location" as const,
              reason: "ambiguous-place" as const,
              prompt: "Which Springfield?",
              choices: ["Springfield, Illinois", "Springfield, Massachusetts"],
              known: { tool: "weather", day: "now" },
            })
          : defaultLookup(_goal, source),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
        if (first.status !== "question") return;
        const ambiguous = yield* interaction.submit(
          submitInput("req-2", "Springfield", {
            interactionId: first.state.interactionId,
            expectedRevision: first.state.revision,
          }),
        );
        assert.strictEqual(ambiguous.status, "question");
        if (ambiguous.status !== "question") return;
        assert.deepStrictEqual(ambiguous.state.pending?.choices, [
          "Springfield, Illinois",
          "Springfield, Massachusetts",
        ]);
        const bound = yield* interaction.submit(
          submitInput("req-3", "Springfield, Massachusetts", {
            interactionId: ambiguous.state.interactionId,
            expectedRevision: ambiguous.state.revision,
          }),
        );
        assert.strictEqual(bound.status, "answered");
        if (bound.status !== "answered" || bound.state.goal.kind !== "lookup") return;
        assert.strictEqual(bound.state.goal.location, "Springfield, Massachusetts");
      }).pipe(Effect.provide(layer)),
  ),
);

it.effect("reports device readiness from observed state, not the preset alone", () =>
  withMemory({}, (layer) =>
    Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      const readiness = yield* interaction.readiness();
      assert.strictEqual(readiness.preset, "full");
      assert.strictEqual(readiness.controlAllowed, true);
      assert.strictEqual(readiness.sessionActive, false);
      const browser = readiness.surfaces.find((surface) => surface.surface === "browser");
      assert.strictEqual(browser?.ready, false);
      assert.match(browser?.reason ?? "", /desktop app|desktop session/i);
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("keeps the interaction inspectable across an owner restart", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-interaction-disk-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const persistence = makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"));
    const first = yield* Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      return yield* interaction.submit(submitInput("req-1", "check the weather"));
    }).pipe(
      Effect.provide(
        interactionLayer().pipe(
          Layer.provideMerge(persistence),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    assert.strictEqual(first.status, "question");
    if (first.status !== "question") return;
    const reopened = yield* Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      return yield* interaction.read({ executionNodeId: nodeId });
    }).pipe(
      Effect.provide(
        interactionLayer().pipe(
          Layer.provideMerge(persistence),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    assert.strictEqual(reopened?.interactionId, first.state.interactionId);
    assert.strictEqual(reopened?.pending?.slot, "location");
    assert.strictEqual(reopened?.revision, 0);
  }),
);

it.effect("starts the approved computer mission against the stored revision", () => {
  let computerRuns = 0;
  return withMemory(
    {
      classify: () => Effect.succeed(computerProposal),
    },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const asked = yield* interaction.submit(
          submitInput("req-1", "click the 7 button on the calculator"),
        );
        assert.strictEqual(asked.status, "question");
        if (asked.status !== "question") return;
        assert.strictEqual(asked.state.pending?.kind, "approval");
        const started = yield* interaction.submit(
          submitInput("req-2", "yes", {
            interactionId: asked.state.interactionId,
            expectedRevision: asked.state.revision,
          }),
        );
        // The old acceptance compared against the consumed revision and
        // answered stale without ever starting the mission.
        assert.strictEqual(started.status, "operation");
        if (started.status !== "operation") return;
        assert.strictEqual(started.operation.status, "completed");
        assert.strictEqual(started.operation.target.surface, "computer");
        const read = yield* interaction.read({
          executionNodeId: nodeId,
          interactionId: asked.state.interactionId,
        });
        assert.strictEqual(read?.revision, started.state.revision);
        assert.strictEqual(read?.operationId, started.operation.operationId);
      }).pipe(Effect.provide(layer)),
    {
      desktopReady: true,
      onComputerRun: () => {
        computerRuns += 1;
      },
    },
  ).pipe(Effect.tap(() => Effect.sync(() => assert.strictEqual(computerRuns, 1))));
});

it.effect("returns the same operation when an approved request is retried while it runs", () =>
  Effect.gen(function* () {
    const missionStarted = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    yield* withMemory(
      { classify: () => Effect.succeed(computerProposal) },
      (layer) =>
        Effect.gen(function* () {
          const interaction = yield* CirceInteraction;
          const asked = yield* interaction.submit(submitInput("req-1", "click 7"));
          if (asked.status !== "question") return;
          const answer = submitInput("req-2", "yes", {
            interactionId: asked.state.interactionId,
            expectedRevision: asked.state.revision,
          });
          const running = yield* interaction.submit(answer).pipe(Effect.forkChild);
          yield* Deferred.await(missionStarted);
          const retried = yield* interaction.submit(answer);
          assert.strictEqual(retried.status, "operation");
          yield* Deferred.succeed(gate, undefined);
          const finished = yield* Fiber.join(running);
          assert.strictEqual(finished.status, "operation");
          if (finished.status !== "operation" || retried.status !== "operation") return;
          assert.strictEqual(retried.operation.operationId, finished.operation.operationId);
        }).pipe(Effect.provide(layer)),
      {
        desktopReady: true,
        computerRun: () =>
          Deferred.succeed(missionStarted, undefined).pipe(Effect.andThen(Deferred.await(gate))),
      },
    );
  }),
);

it.effect("stops the interaction's own desktop operation instead of a coding task", () => {
  const executed: Array<unknown> = [];
  return Effect.gen(function* () {
    const missionStarted = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    yield* withMemory(
      {
        classify: () => Effect.succeed(computerProposal),
        findRunningTask: () =>
          Effect.succeed({
            threadId: "thread-running" as never,
            projectId: "project-running" as never,
            title: "Long task",
          }),
      },
      (layer) =>
        Effect.gen(function* () {
          const interaction = yield* CirceInteraction;
          const asked = yield* interaction.submit(submitInput("req-1", "click 7"));
          if (asked.status !== "question") return;
          const running = yield* interaction
            .submit(
              submitInput("req-2", "yes", {
                interactionId: asked.state.interactionId,
                expectedRevision: asked.state.revision,
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(missionStarted);
          const stopper = yield* interaction
            .submit(
              submitInput("req-3", "stop", {
                interactionId: asked.state.interactionId,
              }),
            )
            .pipe(Effect.forkChild);
          // Let the stop reach its stop-work path without wall-clock time
          // (the test clock does not advance sleeps on its own).
          yield* Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow);
          yield* Deferred.succeed(gate, undefined);
          const stopped = yield* Fiber.join(stopper);
          assert.strictEqual(stopped.status, "cancelled");
          if (stopped.status !== "cancelled") return;
          assert.strictEqual(stopped.state.outcome?.message, "Stopped.");
          yield* Fiber.join(running);
        }).pipe(Effect.provide(layer)),
      {
        desktopReady: true,
        computerRun: () =>
          Deferred.succeed(missionStarted, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        onControllerExecute: (input) => executed.push(input),
      },
    );
  }).pipe(
    Effect.tap(() =>
      Effect.sync(() =>
        assert.strictEqual(
          executed.length,
          0,
          "a stop must not touch the node's coding task while a desktop operation owns the interaction",
        ),
      ),
    ),
  );
});

it.effect("refuses a submission that names a different node", () =>
  withMemory({}, (layer) =>
    Effect.gen(function* () {
      const interaction = yield* CirceInteraction;
      const first = yield* interaction.submit(submitInput("req-1", "check the weather"));
      if (first.status !== "question") return;
      const answer = submitInput("req-2", "Ahmedabad", {
        interactionId: first.state.interactionId,
        expectedRevision: first.state.revision,
      }) as unknown as Record<string, unknown>;
      const other = yield* interaction.submit({
        ...answer,
        preferredNodeId: "node-two",
      } as never);
      assert.strictEqual(other.status, "unavailable");
      const read = yield* interaction.read({
        executionNodeId: nodeId,
        interactionId: first.state.interactionId,
      });
      assert.strictEqual(read?.revision, first.state.revision + 1);
      assert.strictEqual(read?.outcome?.status, "unavailable");
    }).pipe(Effect.provide(layer)),
  ),
);

it.effect("never runs computer use for a confirmation that names another node", () => {
  // Device A asked node B; this node is not B. The confirmation reaches this
  // node, which must record the mismatch instead of driving its own desktop.
  let computerRuns = 0;
  return withMemory(
    { classify: () => Effect.succeed(computerProposal) },
    (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        const asked = yield* interaction.submit(submitInput("remote-1", "click 7"));
        assert.strictEqual(asked.status, "question");
        if (asked.status !== "question") return;
        const confirm = submitInput("remote-2", "yes", {
          interactionId: asked.state.interactionId,
          expectedRevision: asked.state.revision,
        }) as unknown as Record<string, unknown>;
        const other = yield* interaction.submit({ ...confirm, preferredNodeId: "node-b" } as never);
        assert.strictEqual(other.status, "unavailable");
        assert.strictEqual(computerRuns, 0);
      }).pipe(Effect.provide(layer)),
    {
      desktopReady: true,
      onComputerRun: () => {
        computerRuns += 1;
      },
    },
  );
});

it.effect("keeps an accepted operation running and settles it after its requester goes away", () =>
  Effect.gen(function* () {
    const missionStarted = yield* Deferred.make<void>();
    const finishMission = yield* Deferred.make<void>();
    yield* withMemory(
      { classify: () => Effect.succeed(computerProposal) },
      (layer) =>
        Effect.gen(function* () {
          const interaction = yield* CirceInteraction;
          const asked = yield* interaction.submit(submitInput("settle-1", "click 7"));
          assert.strictEqual(asked.status, "question");
          if (asked.status !== "question") return;
          const settled = yield* interaction
            .subscribe({ interactionId: asked.state.interactionId })
            .pipe(
              Stream.filter((state) => state.outcome !== null),
              Stream.runHead,
              Effect.forkChild,
            );
          const requester = yield* interaction
            .submit(
              submitInput("settle-2", "yes", {
                interactionId: asked.state.interactionId,
                expectedRevision: asked.state.revision,
              }),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(missionStarted);
          // The client that approved it disconnects mid-mission.
          yield* Fiber.interrupt(requester);
          yield* Deferred.succeed(finishMission, undefined);
          const outcome = yield* Fiber.join(settled);
          assert.strictEqual(
            outcome._tag === "Some" ? outcome.value.outcome?.status : undefined,
            "completed",
          );
          const read = yield* interaction.read({
            executionNodeId: nodeId,
            interactionId: asked.state.interactionId,
          });
          assert.strictEqual(read?.outcome?.status, "completed");
        }).pipe(Effect.provide(layer)),
      {
        desktopReady: true,
        computerRun: () =>
          Deferred.succeed(missionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishMission)),
          ),
      },
    );
  }),
);

it.effect("marks an operation its node stopped mid-mission as unknown", () =>
  Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-reconcile-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
    );
    const missionStarted = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const interrupted = yield* Effect.gen(function* () {
      return yield* withMemoryAt(
        tempDir,
        { classify: () => Effect.succeed(computerProposal) },
        (layer) =>
          Effect.gen(function* () {
            const interaction = yield* CirceInteraction;
            const asked = yield* interaction.submit(submitInput("req-1", "click 7"));
            if (asked.status !== "question") return null;
            yield* interaction
              .submit(
                submitInput("req-2", "yes", {
                  interactionId: asked.state.interactionId,
                  expectedRevision: asked.state.revision,
                }),
              )
              .pipe(Effect.forkScoped);
            yield* Deferred.await(missionStarted);
            return null;
          }).pipe(Effect.provide(layer)),
        {
          desktopReady: true,
          computerRun: () =>
            Deferred.succeed(missionStarted, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        },
      );
    });
    assert.strictEqual(interrupted, null);
    const recovered = yield* withMemoryAt(tempDir, {}, (layer) =>
      Effect.gen(function* () {
        const interaction = yield* CirceInteraction;
        return yield* interaction.read({ executionNodeId: nodeId });
      }).pipe(Effect.provide(layer)),
    );
    // Shutdown settles it; a crash that skips shutdown is settled by restart
    // reconciliation. Either way it is unknown and never replayed.
    assert.strictEqual(recovered?.outcome?.status, "outcome-unknown");
    assert.match(recovered?.outcome?.message ?? "", /result is unknown/i);
  }),
);
