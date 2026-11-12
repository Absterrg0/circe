import { scopedThreadKey, scopeThreadRef } from "@circe/client/environment";
import type { ScopedThreadRef } from "@circe/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState, type MouseEvent } from "react";

import { useStartNewWork } from "../../hooks/useStartNewWork";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { useProjects, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { useOpenThreadInBackgroundTab } from "../tabs/useOpenThreadInBackgroundTab";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarSectionTitle } from "./SidebarChrome";
import {
  listSidebarChats,
  SIDEBAR_CHATS_PREVIEW_COUNT,
  visibleSidebarChats,
} from "./sidebarSections.logic";
import { useSidebarSectionsStore } from "./sidebarSectionsStore";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const ChatRow = memo(function ChatRow({
  chat,
  active,
  renaming,
  onOpen,
  onOpenInBackground,
  onContextMenu,
  onRenameCommit,
}: {
  readonly chat: SidebarThreadSummary;
  readonly active: boolean;
  readonly renaming: boolean;
  readonly onOpen: (chat: SidebarThreadSummary) => void;
  readonly onOpenInBackground: (chat: SidebarThreadSummary) => void;
  readonly onContextMenu: (chat: SidebarThreadSummary, event: MouseEvent) => void;
  readonly onRenameCommit: (chat: SidebarThreadSummary, title: string | null) => void;
}) {
  if (renaming) {
    return (
      <li className="list-none">
        <input
          autoFocus
          aria-label="Chat name"
          className="circe-chat-row circe-chat-row--editing"
          defaultValue={chat.title}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => onRenameCommit(chat, event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.preventDefault();
              onRenameCommit(chat, null);
            }
          }}
        />
      </li>
    );
  }
  return (
    <li className="list-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="circe-chat-row"
              data-active={active ? "true" : undefined}
              aria-current={active ? "page" : undefined}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey) onOpenInBackground(chat);
                else onOpen(chat);
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                onOpenInBackground(chat);
              }}
              onContextMenu={(event) => onContextMenu(chat, event)}
            />
          }
        >
          {chat.title}
        </TooltipTrigger>
        <TooltipPopup side="right">{chat.title}</TooltipPopup>
      </Tooltip>
    </li>
  );
});

/**
 * The sidebar's Chats list. A chat is a conversation, not a task: its row is
 * its name and nothing else. Rename and delete are on the row's context menu.
 */
export function SidebarChats() {
  const threads = useThreadShells();
  const workspaces = useProjects();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { startChat } = useStartNewWork();
  const { confirmAndDeleteThread } = useThreadActions();
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const openThreadInBackgroundTab = useOpenThreadInBackgroundTab();
  const collapsed = useSidebarSectionsStore((store) => store.collapsed.chats === true);
  const toggle = useSidebarSectionsStore((store) => store.toggle);
  const [expanded, setExpanded] = useState(false);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const activeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;

  const chats = useMemo(
    () =>
      listSidebarChats({
        threads,
        workspaceByKey: new Map(
          workspaces.map((workspace) => [`${workspace.environmentId}:${workspace.id}`, workspace]),
        ),
      }),
    [threads, workspaces],
  );
  const keyOf = (chat: SidebarThreadSummary) =>
    scopedThreadKey(scopeThreadRef(chat.environmentId, chat.id));
  const { visible, hiddenCount } = visibleSidebarChats({
    chats,
    expanded,
    isActive: (chat) => keyOf(chat) === activeKey,
  });

  const open = useCallback(
    (chat: SidebarThreadSummary) => {
      if (isMobile) setOpenMobile(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(chat.environmentId, chat.id)),
      });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const openBackground = useCallback(
    (chat: SidebarThreadSummary) =>
      openThreadInBackgroundTab(scopeThreadRef(chat.environmentId, chat.id)),
    [openThreadInBackgroundTab],
  );
  const commitRename = useCallback(
    (chat: SidebarThreadSummary, title: string | null) => {
      setRenamingKey(null);
      const trimmed = title?.trim() ?? "";
      if (trimmed.length === 0 || trimmed === chat.title) return;
      void updateThreadMetadata({
        environmentId: chat.environmentId,
        input: { threadId: chat.id, title: trimmed },
      }).then((result) => {
        if (result._tag !== "Failure") return;
        toastManager.add(stackedThreadToast({ type: "error", title: "Could not rename the chat" }));
      });
    },
    [updateThreadMetadata],
  );
  const showContextMenu = useCallback(
    async (chat: SidebarThreadSummary, event: MouseEvent) => {
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      const threadRef: ScopedThreadRef = scopeThreadRef(chat.environmentId, chat.id);
      const clicked = await api.contextMenu.show(
        [
          { id: "open-tab", label: "Open in new tab" },
          { id: "rename", label: "Rename" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "open-tab") openBackground(chat);
      if (clicked === "rename") setRenamingKey(scopedThreadKey(threadRef));
      if (clicked === "delete") void confirmAndDeleteThread(threadRef);
    },
    [confirmAndDeleteThread, openBackground],
  );

  return (
    <section aria-label="Chats" className="circe-sidebar-list">
      <SidebarSectionTitle
        title="Chats"
        collapsed={collapsed}
        onToggle={() => toggle("chats")}
        actions={
          startChat === null ? null : (
            <SidebarHeaderIconButton
              label="New chat"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                startChat();
              }}
            >
              <PlusIcon />
            </SidebarHeaderIconButton>
          )
        }
      />
      {collapsed ? null : (
        <ul className="flex flex-col gap-px">
          {visible.map((chat) => {
            const key = keyOf(chat);
            return (
              <ChatRow
                key={key}
                chat={chat}
                active={key === activeKey}
                renaming={key === renamingKey}
                onOpen={open}
                onOpenInBackground={openBackground}
                onContextMenu={(target, event) => void showContextMenu(target, event)}
                onRenameCommit={commitRename}
              />
            );
          })}
          {chats.length === 0 ? (
            <li className="circe-sidebar-list__empty">
              Ask Circe something that is not about a project and it lands here.
            </li>
          ) : null}
          {chats.length > SIDEBAR_CHATS_PREVIEW_COUNT ? (
            <li className="list-none">
              <button
                type="button"
                className="circe-chat-row circe-chat-row--more"
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? "Show fewer" : `Show ${hiddenCount} more`}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
