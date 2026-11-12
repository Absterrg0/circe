// @effect-diagnostics multipleEffectProvide:off - this test composes isolated stub layers around one effect.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type OrchestrationProjectShell } from "@circe/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { isUntypedChatSpace } from "./chatSpace.ts";
import {
  ensureCirceConversationsProject,
  selectChatSpaceWorkspace,
} from "./conversationsProject.ts";

const testCryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const workspace = (
  id: string,
  title: string,
  workspaceRoot: string,
  kind: "project" | "chats" = "project",
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  kind,
  title,
  workspaceRoot,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** Runs startup against the given workspaces and returns what it dispatched. */
const runEnsure = (workspaces: (root: string) => ReadonlyArray<OrchestrationProjectShell>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const root = path.join(config.baseDir, "conversations");
    const dispatched: Array<Record<string, unknown>> = [];
    const projectionsLayer = Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
      getProjectShells: () => Effect.succeed(workspaces(root)),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);
    const orchestrationLayer = Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
      dispatch: (command: Record<string, unknown>) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
    } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]);
    const exit = yield* Effect.exit(
      ensureCirceConversationsProject.pipe(
        Effect.provide(orchestrationLayer),
        Effect.provide(projectionsLayer),
        Effect.provide(testCryptoLayer),
      ),
    );
    return { root, dispatched, exit };
  });

const withNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | NodeServices.NodeServices
  >,
) =>
  effect.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "circe-chat-space-" })),
    Effect.provide(NodeServices.layer),
  );

describe("isUntypedChatSpace", () => {
  it("recognizes only the workspace a node made for chats", () => {
    expect(
      isUntypedChatSpace({ title: "Conversations", workspaceRoot: "/home/u/.circe/conversations" }),
    ).toBe(true);
    expect(
      isUntypedChatSpace({
        title: "Conversations",
        workspaceRoot: "C:\\Users\\u\\.circe\\conversations",
      }),
    ).toBe(true);
    // A user project needs both the title and the folder name to be mistaken.
    expect(
      isUntypedChatSpace({ title: "Conversations", workspaceRoot: "/home/u/code/chat-app" }),
    ).toBe(false);
    expect(
      isUntypedChatSpace({ title: "chat-app", workspaceRoot: "/home/u/code/conversations" }),
    ).toBe(false);
  });
});

describe("selectChatSpaceWorkspace", () => {
  const root = "/home/u/.circe/conversations";

  it("keeps the workspace already typed as the chat space, wherever it is", () => {
    const typed = workspace("typed", "Chats", "/old/.circe/conversations", "chats");
    expect(
      selectChatSpaceWorkspace([workspace("at-root", "Conversations", root), typed], root),
    ).toBe(typed);
  });

  it("takes the workspace at the chat space's directory over an older one elsewhere", () => {
    const atRoot = workspace("at-root", "Conversations", root);
    expect(
      selectChatSpaceWorkspace(
        [workspace("old", "Conversations", "/old/.circe/conversations"), atRoot],
        root,
      ),
    ).toBe(atRoot);
  });

  it("falls back to an untyped chat space left at an old path", () => {
    const old = workspace("old", "Conversations", "/old/.circe/conversations");
    expect(selectChatSpaceWorkspace([workspace("app", "App", "/code/app"), old], root)).toBe(old);
  });

  it("finds nothing among ordinary projects", () => {
    expect(selectChatSpaceWorkspace([workspace("app", "App", "/code/app")], root)).toBeNull();
  });
});

describe("ensureCirceConversationsProject", () => {
  it.effect("creates a typed chat space on a node that has none", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, dispatched } = yield* runEnsure(() => [workspace("app", "App", "/code/app")]);
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toMatchObject({
          type: "project.chat-space.create",
          workspaceRoot: root,
        });
        expect(yield* fs.exists(path.join(root, "AGENTS.md"))).toBe(true);
      }),
    ),
  );

  it.effect("adopts the Conversations project a node recorded before chat spaces were typed", () =>
    withNode(
      Effect.gen(function* () {
        const { root, dispatched } = yield* runEnsure((chatRoot) => [
          workspace("app", "App", "/code/app"),
          workspace("conversations", "Conversations", chatRoot),
        ]);
        expect(dispatched).toEqual([
          expect.objectContaining({
            type: "project.chat-space.adopt",
            projectId: "conversations",
            workspaceRoot: root,
          }),
        ]);
      }),
    ),
  );

  it.effect("moves a chat space whose directory is no longer the node's", () =>
    withNode(
      Effect.gen(function* () {
        const { root, dispatched } = yield* runEnsure(() => [
          workspace("conversations", "Chats", "/old/.circe/conversations", "chats"),
        ]);
        expect(dispatched).toEqual([
          expect.objectContaining({
            type: "project.chat-space.adopt",
            projectId: "conversations",
            workspaceRoot: root,
          }),
        ]);
      }),
    ),
  );

  it.effect("dispatches nothing once the chat space is typed and in place", () =>
    withNode(
      Effect.gen(function* () {
        const { dispatched } = yield* runEnsure((chatRoot) => [
          workspace("conversations", "Chats", chatRoot, "chats"),
        ]);
        expect(dispatched).toEqual([]);
      }),
    ),
  );

  it.effect("fails without creating the chat space when the guidance file cannot be written", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const root = path.join(config.baseDir, "conversations");
        yield* fs.makeDirectory(root, { recursive: true });
        yield* fs.makeDirectory(path.join(root, "AGENTS.md"), { recursive: true });

        const { dispatched, exit } = yield* runEnsure(() => []);
        expect(exit._tag).toBe("Failure");
        expect(dispatched).toEqual([]);
      }),
    ),
  );
});
