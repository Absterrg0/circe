// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@circe/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CirceProjectMemory } from "../Services/CirceProjectMemory.ts";
import { CirceProjectMemoryLive } from "./CirceProjectMemory.ts";

const projectId = ProjectId.make("project-memory-test");

const memoryLayer = (workspaceRoot: string) =>
  CirceProjectMemoryLive.pipe(
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Memory Test",
              workspaceRoot,
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

const withWorkspace = <A, E>(
  program: (memory: CirceProjectMemory["Service"], root: string) => Effect.Effect<A, E>,
) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-circe-memory-"));
  return Effect.gen(function* () {
    const memory = yield* CirceProjectMemory;
    return yield* program(memory, root);
  }).pipe(
    Effect.provide(memoryLayer(root)),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
  );
};

it.effect("stores an episode as a workspace file and returns it in the index", () =>
  withWorkspace((memory, root) =>
    Effect.gen(function* () {
      yield* memory.remember({
        projectId,
        kind: "episode",
        source: "agent",
        title: "Found the test command",
        body: "vp test run <files> is the focused check.",
      });
      const index = yield* memory.index(projectId);
      const list = yield* memory.list(projectId);
      assert.equal(index.entries.length, 1);
      assert.equal(index.entries[0]?.title, "Found the test command");
      assert.isAbove(index.totalTokens, 0);
      assert.equal(list[0]?.corroborationCount, 0);
      const files = NodeFS.readdirSync(NodePath.join(root, ".circe", "memory"));
      assert.include(files, "index.md");
      assert.equal(files.filter((name) => name.endsWith(".md") && name !== "index.md").length, 1);
    }),
  ),
);

it.effect("refuses an uncorroborated agent fact and allows a confirmed one", () =>
  withWorkspace((memory) =>
    Effect.gen(function* () {
      const refused = yield* memory
        .remember({
          projectId,
          kind: "fact",
          source: "agent",
          title: "Uses pnpm",
          body: "pnpm is the package manager.",
        })
        .pipe(Effect.exit);
      assert.equal(refused._tag, "Failure");
      const accepted = yield* memory.remember({
        projectId,
        kind: "fact",
        source: "user",
        title: "Uses pnpm",
        body: "pnpm is the package manager.",
        confirmed: true,
      });
      assert.equal(accepted.kind, "fact");
      assert.isNotNull(accepted.expiresAt);
    }),
  ),
);

it.effect("retains a refused agent fact so a repeated claim can promote it", () =>
  withWorkspace((memory) =>
    Effect.gen(function* () {
      const claim = (title: string) =>
        memory
          .remember({
            projectId,
            kind: "fact",
            source: "agent",
            title,
            body: "The release job runs Friday.",
          })
          .pipe(Effect.exit);

      const first = yield* claim("Deploys on Fridays");
      assert.equal(first._tag, "Failure");
      // The refused claim is retained as pending evidence rather than dropped.
      const afterFirst = yield* memory.list(projectId);
      assert.equal(afterFirst.length, 1);
      assert.equal(afterFirst[0]?.kind, "episode");

      const second = yield* claim("deploys ON fridays");
      assert.equal(second._tag, "Failure");
      assert.equal((yield* memory.list(projectId))[0]?.corroborationCount, 1);

      const promoted = yield* memory.remember({
        projectId,
        kind: "fact",
        source: "agent",
        title: " Deploys on Fridays ",
        body: "The release job runs Friday.",
      });
      assert.equal(promoted.kind, "fact");
      assert.equal(promoted.corroborationCount, 2);
      assert.isNotNull(promoted.expiresAt);
    }),
  ),
);

it.effect("corroborates a repeated claim instead of duplicating it", () =>
  withWorkspace((memory) =>
    Effect.gen(function* () {
      yield* memory.remember({
        projectId,
        kind: "episode",
        source: "agent",
        title: "Runner is flaky",
        body: "First observation.",
      });
      yield* memory.remember({
        projectId,
        kind: "episode",
        source: "agent",
        title: "  runner IS flaky ",
        body: "Second observation.",
      });
      const list = yield* memory.list(projectId);
      assert.equal(list.length, 1);
      assert.equal(list[0]?.corroborationCount, 1);
    }),
  ),
);

it.effect("moves a forgotten entry to the retired folder so provenance survives", () =>
  withWorkspace((memory, root) =>
    Effect.gen(function* () {
      const entry = yield* memory.remember({
        projectId,
        kind: "episode",
        source: "agent",
        title: "Temporary note",
        body: "Delete me.",
      });
      const forget = yield* memory.forget({ projectId, entryId: entry.id });
      assert.isTrue(forget.forgotten);
      const index = yield* memory.index(projectId);
      assert.equal(index.entries.length, 0);
      const retired = NodeFS.readdirSync(NodePath.join(root, ".circe", "memory", "retired"));
      assert.include(retired, `${entry.id}.md`);
    }),
  ),
);
