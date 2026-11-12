import { isChatWorkspace, type WorkspaceKind } from "@circe/contracts";

import type { SidebarThreadSummary } from "../../types";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

/** Chats shown before the list offers to show the rest. */
export const SIDEBAR_CHATS_PREVIEW_COUNT = 8;

type ChatCandidate = Pick<SidebarThreadSummary, "archivedAt" | "lineage"> & {
  readonly environmentId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly latestUserMessageAt: string | null;
};

/**
 * The sidebar's chats: every thread in a chat space that is not archived and
 * is not a subagent's child, most recently asked first. Settling and snoozing
 * are agent-work concepts and do not hide a chat. Ordering uses the last
 * message the user sent, so reading a chat does not move it.
 */
export function listSidebarChats<T extends ChatCandidate>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly workspaceByKey: ReadonlyMap<
    string,
    { readonly title: string; readonly kind?: WorkspaceKind | undefined }
  >;
}): T[] {
  const askedAt = (thread: T) => thread.latestUserMessageAt ?? thread.createdAt;
  return filterSidebarV2VisibleThreads(input.threads, null)
    .filter((thread) => {
      const workspace = input.workspaceByKey.get(`${thread.environmentId}:${thread.projectId}`);
      return workspace !== undefined && isChatWorkspace(workspace);
    })
    .toSorted((left, right) => askedAt(right).localeCompare(askedAt(left)));
}

/**
 * The chats to render: the newest few, plus the open chat when it is older
 * than those, so the row for what is on screen never disappears.
 */
export function visibleSidebarChats<T>(input: {
  readonly chats: ReadonlyArray<T>;
  readonly expanded: boolean;
  readonly isActive: (chat: T) => boolean;
}): { readonly visible: ReadonlyArray<T>; readonly hiddenCount: number } {
  if (input.expanded || input.chats.length <= SIDEBAR_CHATS_PREVIEW_COUNT) {
    return { visible: input.chats, hiddenCount: 0 };
  }
  const head = input.chats.slice(0, SIDEBAR_CHATS_PREVIEW_COUNT);
  const active = input.chats.slice(SIDEBAR_CHATS_PREVIEW_COUNT).find(input.isActive);
  const visible = active === undefined ? head : [...head, active];
  return { visible, hiddenCount: input.chats.length - visible.length };
}
