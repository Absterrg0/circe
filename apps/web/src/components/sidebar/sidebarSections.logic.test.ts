import { ThreadId } from "@circe/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  listSidebarChats,
  SIDEBAR_CHATS_PREVIEW_COUNT,
  visibleSidebarChats,
} from "./sidebarSections.logic";

const workspaceByKey = new Map([
  ["env:chat-space", { title: "Chats", kind: "chats" as const }],
  ["env:app", { title: "App", kind: "project" as const }],
  // A node that predates typed chat spaces sends only the old title.
  ["old:chat-space", { title: "Conversations" }],
]);

function thread(input: {
  id: string;
  projectId?: string;
  environmentId?: string;
  askedAt?: string | null;
  createdAt?: string;
  archivedAt?: string | null;
  subagent?: boolean;
}) {
  return {
    id: input.id,
    environmentId: input.environmentId ?? "env",
    projectId: input.projectId ?? "chat-space",
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    latestUserMessageAt: input.askedAt === undefined ? null : input.askedAt,
    archivedAt: input.archivedAt ?? null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: input.subagent ? ("subagent" as const) : null,
      rootThreadId: ThreadId.make(input.id),
    },
  };
}

const ids = (threads: ReadonlyArray<{ id: string }>) => threads.map((entry) => entry.id);

describe("listSidebarChats", () => {
  it("lists threads in a chat space and leaves agent work out", () => {
    const chats = listSidebarChats({
      workspaceByKey,
      threads: [
        thread({ id: "chat" }),
        thread({ id: "agent", projectId: "app" }),
        thread({ id: "old-node-chat", environmentId: "old" }),
        thread({ id: "unknown-workspace", projectId: "not-loaded" }),
      ],
    });
    expect(ids(chats)).toEqual(["chat", "old-node-chat"]);
  });

  it("drops archived chats and subagent children", () => {
    const chats = listSidebarChats({
      workspaceByKey,
      threads: [
        thread({ id: "kept" }),
        thread({ id: "archived", archivedAt: "2026-01-02T00:00:00.000Z" }),
        thread({ id: "child", subagent: true }),
      ],
    });
    expect(ids(chats)).toEqual(["kept"]);
  });

  it("orders by the last message the user sent, newest first", () => {
    const chats = listSidebarChats({
      workspaceByKey,
      threads: [
        thread({ id: "older", askedAt: "2026-01-02T00:00:00.000Z" }),
        thread({ id: "newest", askedAt: "2026-01-05T00:00:00.000Z" }),
        // Never asked in: falls back to when it was created.
        thread({ id: "unsent", createdAt: "2026-01-03T00:00:00.000Z" }),
      ],
    });
    expect(ids(chats)).toEqual(["newest", "unsent", "older"]);
  });
});

describe("visibleSidebarChats", () => {
  const chats = Array.from({ length: SIDEBAR_CHATS_PREVIEW_COUNT + 4 }, (_, index) => ({
    id: `chat-${index}`,
  }));

  it("shows every chat when there are few", () => {
    const few = chats.slice(0, SIDEBAR_CHATS_PREVIEW_COUNT);
    expect(visibleSidebarChats({ chats: few, expanded: false, isActive: () => false })).toEqual({
      visible: few,
      hiddenCount: 0,
    });
  });

  it("shows the newest few and counts the rest", () => {
    const result = visibleSidebarChats({ chats, expanded: false, isActive: () => false });
    expect(ids(result.visible)).toEqual(ids(chats.slice(0, SIDEBAR_CHATS_PREVIEW_COUNT)));
    expect(result.hiddenCount).toBe(4);
  });

  it("keeps the open chat's row when it is older than the preview", () => {
    const open = chats.at(-1)!;
    const result = visibleSidebarChats({
      chats,
      expanded: false,
      isActive: (chat) => chat.id === open.id,
    });
    expect(result.visible.at(-1)).toBe(open);
    expect(result.hiddenCount).toBe(3);
  });

  it("shows everything once expanded", () => {
    expect(visibleSidebarChats({ chats, expanded: true, isActive: () => false })).toEqual({
      visible: chats,
      hiddenCount: 0,
    });
  });
});
