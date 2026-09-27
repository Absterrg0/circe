import type { WorkspaceKind } from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/**
 * The node's chat space: the one workspace where conversations that are not
 * about a codebase run. A provider always runs in a directory, so chats get
 * this node-owned one instead of a user project. The node creates it at a
 * fixed root under its base directory, and that root, not the title, is what
 * makes a workspace the chat space.
 */
export const circeChatSpaceRoot = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "conversations");
});

/** How a workspace is typed on the wire, given this node's chat space root. */
export function workspaceKindOf(workspaceRoot: string, chatSpaceRoot: string): WorkspaceKind {
  return workspaceRoot === chatSpaceRoot ? "chats" : "project";
}
