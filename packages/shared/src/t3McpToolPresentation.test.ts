import { describe, expect, it } from "vite-plus/test";

import { resolveT3McpToolPresentation } from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("pretty prints Claude and Cursor T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("mcp__circe__t3_thread_read")).toEqual({
      displayName: "Read a T3 thread",
      logo: "circe",
    });
  });

  it("pretty prints Codex T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("circe.create_threads")).toEqual({
      displayName: "Create T3 threads",
      logo: "circe",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveT3McpToolPresentation("mcp__circe__t3_thread_update")).toEqual({
      displayName: "Update T3 thread metadata",
      logo: "circe",
    });
  });

  it("pretty prints bare T3 MCP toolkit names", () => {
    expect(resolveT3McpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "circe",
    });
  });

  it("pretty prints worktree T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("mcp__circe__t3_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "circe",
    });
    expect(resolveT3McpToolPresentation("circe.t3_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "circe",
    });
  });

  it("pretty prints preview T3 MCP tool names", () => {
    expect(resolveT3McpToolPresentation("Circe.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "circe",
    });
    expect(resolveT3McpToolPresentation("mcp__circe__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "circe",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_circe_delegate_task",
      "circe:delegate_task",
      "circe/delegate_task",
      "circe delegate_task",
      "Circe delegate_task",
      "circe__delegate_task",
    ]) {
      expect(resolveT3McpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveT3McpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveT3McpToolPresentation("circe.not_a_real_tool")).toBeNull();
  });
});
