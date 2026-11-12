import { LEGACY_CHAT_SPACE_TITLE } from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/**
 * Where the node's chat space lives: the one workspace where conversations
 * that are not about a codebase run. A provider always runs in a directory, so
 * chats get this node-owned one instead of a user project. Which workspace is
 * the chat space is stored on the workspace (`kind: "chats"`); this path only
 * says where it should be.
 */
export const circeChatSpaceRoot = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "conversations");
});

/**
 * Whether a workspace recorded as a project is really a chat space from
 * before chat spaces were typed. Nodes created it as "Conversations" in a
 * `conversations` directory under their own base directory, so both must
 * match. A user project that merely has that title or folder name does not.
 */
export function isUntypedChatSpace(workspace: {
  readonly title: string;
  readonly workspaceRoot: string;
}): boolean {
  return (
    workspace.title === LEGACY_CHAT_SPACE_TITLE &&
    /[\\/]conversations[\\/]?$/.test(workspace.workspaceRoot)
  );
}
