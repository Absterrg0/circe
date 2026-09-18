// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@circe/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CirceController, type CirceExecutionResult } from "../Services/CirceController.ts";
import { CirceCoordinator } from "../Services/CirceCoordinator.ts";
import { CirceProjectMemory } from "../Services/CirceProjectMemory.ts";
import { CirceCoordinatorLive } from "./CirceCoordinator.ts";

const projectRef = {
  nodeId: EnvironmentId.make("node-coordinator-test"),
  projectId: ProjectId.make("project-coordinator-test"),
};
const sessionId = AuthSessionId.make("session-coordinator-test");

const started = (objective: string): CirceExecutionResult => ({
  status: "started",
  threadId: ThreadId.make("thread-coordinator-test"),
  projectId: projectRef.projectId,
  objective,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
});

const layerFor = (root: string, calls: Array<string>) =>
  CirceCoordinatorLive.pipe(
    Layer.provideMerge(
      Layer.mock(CirceController)({
        execute: (input) =>
          Effect.sync(() => {
            calls.push(`execute:${input.utterance}`);
            return started(input.utterance);
          }),
        interpret: () => Effect.die("interpret is not used by this test"),
        converse: () => Effect.die("converse is not used by this test"),
        cancelRequest: () => Effect.die("cancelRequest is not used by this test"),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(CirceProjectMemory)({
        remember: (input) =>
          Effect.sync(() => {
            calls.push(`remember:${input.title}`);
            return {
              id: "mem-1",
              projectId: input.projectId,
              kind: input.kind,
              source: input.source,
              title: input.title,
              body: input.body,
              tags: [],
              corroborationCount: 0,
              status: "active" as const,
              createdAt: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
              updatedAt: DateTime.makeUnsafe("2026-08-12T00:00:00.000Z"),
              expiresAt: null,
            };
          }),
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        index: () =>
          Effect.succeed({ projectId: projectRef.projectId, entries: [], totalTokens: 0 }),
        forget: () => Effect.succeed({ forgotten: false }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              id: projectRef.projectId,
              title: "Coordinator Test",
              workspaceRoot: root,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-08-12T00:00:00.000Z",
              updatedAt: "2026-08-12T00:00:00.000Z",
            }),
          ),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const withCoordinator = <A, E>(
  program: (
    coordinator: CirceCoordinator["Service"],
    root: string,
    calls: Array<string>,
  ) => Effect.Effect<A, E>,
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-circe-coordinator-"));
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    const coordinator = yield* CirceCoordinator;
    return yield* program(coordinator, root, calls);
  }).pipe(
    Effect.provide(layerFor(root, calls)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
};

it.effect("writes the goal and a managed AGENTS.md block exactly once", () =>
  withCoordinator((coordinator, root) =>
    Effect.gen(function* () {
      yield* coordinator.setGoal({ projectRef, goal: "Ship Circe." });
      yield* coordinator.setGoal({ projectRef, goal: "Ship Circe well." });
      const context = yield* coordinator.getContext(projectRef);
      assert.equal(context.goal, "Ship Circe well.");
      const agents = NodeFS.readFileSync(NodePath.join(root, "AGENTS.md"), "utf8");
      assert.equal(agents.split("<!-- circe:begin -->").length - 1, 1);
      assert.include(agents, "Ship Circe well.");
      assert.include(agents, "Project: Coordinator Test");
    }),
  ),
);

it.effect("routes an instruction to a thread and records an episode", () =>
  withCoordinator((coordinator, _root, calls) =>
    Effect.gen(function* () {
      yield* coordinator.setGoal({ projectRef, goal: "Ship Circe." });
      const result = yield* coordinator.coordinate({
        projectRef,
        utterance: "add a coordinator test",
        sessionId,
      });
      assert.equal(result.status, "started");
      assert.deepEqual(calls, [
        "execute:add a coordinator test",
        "remember:add a coordinator test",
      ]);
    }),
  ),
);
