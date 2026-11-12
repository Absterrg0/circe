import { CommandId, ProjectId, type OrchestrationProjectShell } from "@circe/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { circeChatSpaceRoot, isUntypedChatSpace } from "./chatSpace.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * Circe keeps general questions out of the user's coding projects. Every chat
 * runs in the node's chat space, a workspace of kind `chats` whose directory
 * carries the conversational provider guidance in AGENTS.md, so the guidance
 * never leaks into the visible transcript.
 */
export const CIRCE_CONVERSATIONS_AGENTS_MD = [
  "# Conversations",
  "",
  "This project holds Circe general-question threads. Nothing here is a coding task.",
  "",
  "- You have full shell access in this workspace.",
  "- When the answer depends on live or external data (weather, prices, schedules, current facts), fetch it with a command before answering.",
  "- For example: curl -s 'wttr.in/<city>?format=3'.",
  "- Do not claim you cannot access live data without trying.",
  "- Keep answers short and direct; they are read aloud.",
  "",
].join("\n");

/** The chat space's workspace id, or null before startup has created it. */
export const resolveCirceConversationsProjectId = circeChatSpaceRoot.pipe(
  Effect.flatMap((root) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const existing = yield* projections.getActiveProjectByWorkspaceRoot(root);
      return Option.isSome(existing) && existing.value.kind === "chats" ? existing.value.id : null;
    }),
  ),
  Effect.orElseSucceed(() => null),
);

/**
 * Which workspace the node should take as its chat space, given the ones it
 * has. In order: the one already typed as a chat space; the one sitting at the
 * chat space's directory; a chat space from before typing existed, which a
 * moved base directory left at its old path. Null means create one.
 */
export function selectChatSpaceWorkspace<
  T extends Pick<OrchestrationProjectShell, "kind" | "title" | "workspaceRoot">,
>(workspaces: ReadonlyArray<T>, chatSpaceRoot: string): T | null {
  return (
    workspaces.find((workspace) => workspace.kind === "chats") ??
    workspaces.find((workspace) => workspace.workspaceRoot === chatSpaceRoot) ??
    workspaces.find(isUntypedChatSpace) ??
    null
  );
}

/**
 * Make sure the node has exactly one chat space, at its directory, with its
 * AGENTS.md. Safe on every startup. A node that recorded its chat space as a
 * project titled "Conversations" has that workspace adopted here, so its
 * chats keep their workspace and stop appearing under a project.
 */
export const ensureCirceConversationsProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const root = yield* circeChatSpaceRoot;

  yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  const agentsPath = path.join(root, "AGENTS.md");
  const existingAgents = yield* fs
    .readFileString(agentsPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (existingAgents === null) {
    yield* fs.writeFileString(agentsPath, CIRCE_CONVERSATIONS_AGENTS_MD);
  }

  const workspace = selectChatSpaceWorkspace(yield* projections.getProjectShells(), root);
  if (workspace === null) {
    const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
    yield* orchestration.dispatch({
      type: "project.chat-space.create",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      projectId,
      workspaceRoot: root,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    return projectId;
  }
  if (workspace.kind !== "chats" || workspace.workspaceRoot !== root) {
    yield* orchestration.dispatch({
      type: "project.chat-space.adopt",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      projectId: workspace.id,
      workspaceRoot: root,
    });
  }
  return workspace.id;
});
