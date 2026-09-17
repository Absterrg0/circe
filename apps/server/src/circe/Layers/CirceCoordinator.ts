import type {
  CirceExecutionResult,
  CirceProjectContext,
  CirceProjectGoalInput,
  CirceProjectRef,
} from "@circe/contracts";
import { buildProjectPinnedContext, renderMemoryIndex } from "@circe/core/projectMemory";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  AGENTS_FILE,
  CIRCE_DIR,
  CONTEXT_FILE,
  MEMORY_DIR,
  upsertAgentsBlock,
} from "../projectMemory/memoryFiles.ts";
import { CirceController } from "../Services/CirceController.ts";
import { CirceCoordinator, type CirceCoordinatorShape } from "../Services/CirceCoordinator.ts";
import { CirceMemoryStoreError, CirceProjectMemory } from "../Services/CirceProjectMemory.ts";

const GOAL_FILE = "goal.md";
const MEMORY_POINTER = `Memory files live under ${CIRCE_DIR}/${MEMORY_DIR}/. Read one by id when it matters to the task.`;

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const memory = yield* CirceProjectMemory;
  const controller = yield* CirceController;

  const storeError = (projectId: string, operation: string, cause?: unknown) =>
    new CirceMemoryStoreError({
      projectId: projectId as CirceProjectRef["projectId"],
      operation,
      ...(cause === undefined ? {} : { cause }),
    });

  const projectShell = (projectRef: CirceProjectRef) =>
    projections.getProjectShellById(projectRef.projectId).pipe(
      Effect.mapError((cause) =>
        storeError(projectRef.projectId, "resolve the project workspace", cause),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(storeError(projectRef.projectId, "resolve the project workspace")),
          onSome: (project) => Effect.succeed(project),
        }),
      ),
    );

  const goalPath = (root: string) => path.join(root, CIRCE_DIR, GOAL_FILE);
  const contextPath = (root: string) => path.join(root, CIRCE_DIR, CONTEXT_FILE);
  const agentsPath = (root: string) => path.join(root, AGENTS_FILE);

  const readGoal = (projectId: string, root: string) =>
    fs.readFileString(goalPath(root)).pipe(
      Effect.map((text) => text.trim()),
      Effect.map((text) => (text.length === 0 ? null : text)),
      Effect.orElseSucceed(() => null),
      Effect.mapError((cause) => storeError(projectId, "read the project goal", cause)),
    );

  const renderPinned = (
    projectId: CirceProjectRef["projectId"],
    projectTitle: string,
    goal: string | null,
  ) =>
    memory.index(projectId).pipe(
      Effect.map((index) =>
        buildProjectPinnedContext({
          projectTitle,
          ...(goal === null ? {} : { brief: goal }),
          memoryIndexBlock: renderMemoryIndex({
            entries: index.entries,
            totalTokens: index.totalTokens,
          }),
        }),
      ),
    );

  const contextFor = (projectRef: CirceProjectRef) =>
    Effect.gen(function* () {
      const project = yield* projectShell(projectRef);
      const goal = yield* readGoal(projectRef.projectId, project.workspaceRoot);
      const pinnedContext = yield* renderPinned(projectRef.projectId, project.title, goal);
      return { projectRef, goal, pinnedContext } satisfies CirceProjectContext;
    });

  /** Write the pinned context only when it changed, so a repo is not churned. */
  const writePinned = (projectId: string, root: string, pinnedContext: string) =>
    Effect.gen(function* () {
      const contextFile = contextPath(root);
      const existingContext = yield* fs
        .readFileString(contextFile)
        .pipe(Effect.orElseSucceed(() => null));
      if (existingContext !== pinnedContext) {
        yield* fs
          .makeDirectory(path.join(root, CIRCE_DIR), { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              storeError(projectId, "create the context directory", cause),
            ),
          );
        yield* fs
          .writeFileString(contextFile, pinnedContext)
          .pipe(
            Effect.mapError((cause) => storeError(projectId, "write the pinned context", cause)),
          );
      }
      const agents = agentsPath(root);
      const existingAgents = yield* fs
        .readFileString(agents)
        .pipe(Effect.orElseSucceed(() => null));
      const next = upsertAgentsBlock(
        existingAgents,
        pinnedContext.length === 0 ? MEMORY_POINTER : `${pinnedContext}\n\n${MEMORY_POINTER}`,
      );
      if (next !== existingAgents) {
        yield* fs
          .writeFileString(agents, next)
          .pipe(
            Effect.mapError((cause) =>
              storeError(projectId, "write the managed AGENTS.md block", cause),
            ),
          );
      }
    });

  const getContext: CirceCoordinatorShape["getContext"] = (projectRef) => contextFor(projectRef);

  const setGoal: CirceCoordinatorShape["setGoal"] = (input: CirceProjectGoalInput) =>
    Effect.gen(function* () {
      const project = yield* projectShell(input.projectRef);
      yield* fs
        .makeDirectory(path.join(project.workspaceRoot, CIRCE_DIR), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            storeError(input.projectRef.projectId, "create the context directory", cause),
          ),
        );
      yield* fs
        .writeFileString(goalPath(project.workspaceRoot), `${input.goal.trim()}\n`)
        .pipe(
          Effect.mapError((cause) =>
            storeError(input.projectRef.projectId, "write the goal", cause),
          ),
        );
      const context = yield* contextFor(input.projectRef);
      yield* writePinned(input.projectRef.projectId, project.workspaceRoot, context.pinnedContext);
      return context;
    });

  const recordEpisode = (projectRef: CirceProjectRef, utterance: string) => {
    const title = utterance.trim().slice(0, 80);
    if (title.length === 0) return Effect.void;
    return memory
      .remember({
        projectId: projectRef.projectId,
        kind: "episode",
        source: "user",
        title,
        body: utterance.trim(),
      })
      .pipe(Effect.orElseSucceed(() => undefined));
  };

  const coordinate: CirceCoordinatorShape["coordinate"] = (input) =>
    Effect.gen(function* () {
      const project = yield* projectShell(input.projectRef);
      const context = yield* contextFor(input.projectRef);
      yield* writePinned(input.projectRef.projectId, project.workspaceRoot, context.pinnedContext);
      const result = yield* controller.execute({
        sessionId: input.sessionId,
        projectId: input.projectRef.projectId,
        utterance: input.utterance,
        ...(input.requestMetadata === undefined ? {} : { requestMetadata: input.requestMetadata }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.executionNodeId === undefined ? {} : { executionNodeId: input.executionNodeId }),
      });
      if (result.status === "started" || result.status === "acknowledged") {
        yield* recordEpisode(input.projectRef, input.utterance);
      }
      return result;
    });

  const remember: CirceCoordinatorShape["remember"] = (input) =>
    memory
      .remember({
        projectId: input.projectRef.projectId,
        kind: input.kind,
        source: input.source,
        title: input.title,
        body: input.body,
        ...(input.tags === undefined ? {} : { tags: [...input.tags] }),
        ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
      })
      .pipe(Effect.asVoid);

  return CirceCoordinator.of({ getContext, setGoal, coordinate, remember });
});

export const CirceCoordinatorLive = Layer.effect(CirceCoordinator, make);
