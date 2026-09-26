import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CIRCE_CONVERSATIONS_PROJECT_TITLE,
  ProjectId,
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

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { layer as projectionLayer } from "../../orchestration-v2/ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeNodeHost } from "./nodeHost.ts";

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

const withProject = (workspaceRoot: string) =>
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
