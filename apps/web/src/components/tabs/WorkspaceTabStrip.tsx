import { scopeProjectRef, scopeThreadRef } from "@circe/client/environment";
import {
  isChatWorkspace,
  type CirceBotId,
  type EnvironmentId,
  type ThreadId,
} from "@circe/contracts";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement } from "@dnd-kit/modifiers";
import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  BotIcon,
  ChartNoAxesColumnIcon,
  HouseIcon,
  MessageCircleIcon,
  MonitorSmartphoneIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useStartNewWork } from "../../hooks/useStartNewWork";
import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { circeBotsEnvironment } from "../../state/circeBots";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { resolveThreadRouteRenderState } from "../../threadRoutes";
import {
  tabAtOffset,
  tabTargetOfHref,
  type WorkspacePage,
  type WorkspaceTab,
  type WorkspaceTabTarget,
} from "../../workspaceTabs.logic";
import { useWorkspaceTabsStore } from "../../workspaceTabsStore";
import { CirceStatusGlyph, toneForTaskStatus, type CirceTone } from "../circe/CirceStatusGlyph";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarTrigger } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import "./workspace-tabs.css";

const PAGE_TABS: Record<WorkspacePage, { readonly title: string; readonly icon: ReactNode }> = {
  home: { title: "Home", icon: <HouseIcon /> },
  "pull-requests": { title: "Pull requests", icon: <PullRequestGlyph.pullRequest /> },
  machines: { title: "Machines", icon: <MonitorSmartphoneIcon /> },
  usage: { title: "Usage", icon: <ChartNoAxesColumnIcon /> },
  settings: { title: "Settings", icon: <SettingsIcon /> },
};

interface TabFace {
  readonly title: string;
  readonly icon: ReactNode;
  /** A task state worth showing in place of the icon: running, needs you, failed. */
  readonly tone?: CirceTone | undefined;
  readonly toneLabel?: string | undefined;
  /** What the tab showed no longer exists: a deleted thread, a discarded draft. */
  readonly gone?: boolean;
}

const TONE_LABEL: Partial<Record<CirceTone, string>> = {
  running: "Running",
  attention: "Needs you",
  failed: "Failed",
};

/**
 * What a tab reads as. Each kind subscribes only to its own source, and falls
 * back to the title the tab last showed while that source loads.
 */
function useThreadTabFace(
  target: Extract<WorkspaceTabTarget, { kind: "thread" }>,
  cachedLabel: string | null,
): TabFace {
  const threadRef = scopeThreadRef(
    target.environmentId as EnvironmentId,
    target.threadId as ThreadId,
  );
  const thread = useThreadShell(threadRef);
  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const draftThreadExists = useComposerDraftStore(
    (store) => store.getDraftThreadByRef(threadRef) !== null,
  );
  // The same rule the thread page uses, so a tab never outlives a thread the
  // page would refuse to show. An environment still loading is not "gone".
  const gone =
    thread?.archivedAt != null ||
    resolveThreadRouteRenderState({
      bootstrapComplete: shell.data?.snapshot._tag === "Some",
      serverThreadExists: thread !== null,
      serverThreadDeleted: thread?.deletedAt != null,
      draftThreadExists,
    }) === "missing";
  const workspace = useProject(
    thread === null ? null : scopeProjectRef(thread.environmentId, thread.projectId),
  );
  const isChat = workspace !== null && isChatWorkspace(workspace);
  const tone = thread === null ? undefined : toneForTaskStatus(resolveSidebarThreadStatus(thread));
  return {
    title: thread?.title ?? cachedLabel ?? "Thread",
    icon: isChat ? <MessageCircleIcon /> : <SquareTerminalIcon />,
    tone: tone !== undefined && TONE_LABEL[tone] !== undefined ? tone : undefined,
    toneLabel: tone === undefined ? undefined : TONE_LABEL[tone],
    gone,
  };
}

function useDraftTabFace(target: Extract<WorkspaceTabTarget, { kind: "draft" }>): TabFace {
  const draft = useComposerDraftStore((store) => store.getDraftSession(target.draftId as DraftId));
  const workspace = useProject(
    draft === null ? null : scopeProjectRef(draft.environmentId, draft.projectId),
  );
  const isChat = workspace !== null && isChatWorkspace(workspace);
  return {
    title: isChat ? "New chat" : "New thread",
    icon: isChat ? <MessageCircleIcon /> : <SquarePenIcon />,
    gone: draft === null,
  };
}

function useBotTabFace(
  target: Extract<WorkspaceTabTarget, { kind: "bot" }>,
  cachedLabel: string | null,
): TabFace {
  const roster = useAtomValue(
    circeBotsEnvironment.roster({
      environmentId: target.environmentId as EnvironmentId,
      input: {},
    }),
  );
  const bots = Option.getOrNull(AsyncResult.value(roster))?.bots ?? [];
  const bot = bots.find((summary) => summary.bot.botId === (target.botId as CirceBotId));
  return { title: bot?.bot.name ?? cachedLabel ?? "Bot", icon: <BotIcon /> };
}

type TabBodyProps = {
  readonly tab: WorkspaceTab;
  readonly children: (face: TabFace) => ReactNode;
};

function ThreadTabBody({
  tab,
  target,
  children,
}: TabBodyProps & { readonly target: Extract<WorkspaceTabTarget, { kind: "thread" }> }) {
  return children(useThreadTabFace(target, tab.label));
}

function DraftTabBody({
  target,
  children,
}: TabBodyProps & { readonly target: Extract<WorkspaceTabTarget, { kind: "draft" }> }) {
  return children(useDraftTabFace(target));
}

function BotTabBody({
  tab,
  target,
  children,
}: TabBodyProps & { readonly target: Extract<WorkspaceTabTarget, { kind: "bot" }> }) {
  return children(useBotTabFace(target, tab.label));
}

function TabBody(props: TabBodyProps) {
  const target = tabTargetOfHref(props.tab.href);
  switch (target?.kind) {
    case "thread":
      return <ThreadTabBody {...props} target={target} />;
    case "draft":
      return <DraftTabBody {...props} target={target} />;
    case "bot":
      return <BotTabBody {...props} target={target} />;
    case "page":
      return props.children(PAGE_TABS[target.page]);
    case undefined:
      return props.children({ title: props.tab.label ?? "Tab", icon: null });
  }
}

/**
 * Remembers a resolved title so a restored tab is named before its data
 * loads, and closes a background tab whose thread or draft is gone. The tab
 * on screen is left to its page, which redirects it in place.
 */
function TabUpkeep({
  tabId,
  face,
  active,
}: {
  readonly tabId: string;
  readonly face: TabFace;
  readonly active: boolean;
}) {
  const setLabel = useWorkspaceTabsStore((store) => store.setLabel);
  const close = useWorkspaceTabsStore((store) => store.close);
  const gone = face.gone === true;
  useEffect(() => {
    if (!gone) setLabel(tabId, face.title);
  }, [face.title, gone, setLabel, tabId]);
  useEffect(() => {
    if (gone && !active) close(tabId);
  }, [active, close, gone, tabId]);
  return null;
}

const WorkspaceTabItem = memo(function WorkspaceTabItem({
  tab,
  active,
  closable,
  onActivate,
  onClose,
  onStep,
}: {
  readonly tab: WorkspaceTab;
  readonly active: boolean;
  readonly closable: boolean;
  readonly onActivate: (tab: WorkspaceTab) => void;
  readonly onClose: (tabId: string) => void;
  readonly onStep: (offset: number) => void;
}) {
  const router = useRouter();
  const keep = useWorkspaceTabsStore((store) => store.keep);
  const closeOthers = useWorkspaceTabsStore((store) => store.closeOthers);
  const closeToRight = useWorkspaceTabsStore((store) => store.closeToRight);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  const elementRef = useRef<HTMLDivElement | null>(null);

  // A tab opened or focused from the sidebar may sit outside the scrolled strip.
  useEffect(() => {
    if (active) elementRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const handleContextMenu = async (event: MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        ...(tab.kept ? [] : [{ id: "keep" as const, label: "Keep open" }]),
        { id: "close" as const, label: "Close", disabled: !closable },
        { id: "close-others" as const, label: "Close others" },
        { id: "close-right" as const, label: "Close to the right" },
      ],
      { x: event.clientX, y: event.clientY },
    );
    const go = (href: string | null) => {
      if (href !== null) router.history.push(href);
    };
    if (clicked === "keep") keep(tab.id);
    if (clicked === "close") onClose(tab.id);
    if (clicked === "close-others") go(closeOthers(tab.id));
    if (clicked === "close-right") go(closeToRight(tab.id));
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(tab);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onStep(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      onStep(-1);
    } else if ((event.key === "Delete" || event.key === "Backspace") && closable) {
      event.preventDefault();
      onClose(tab.id);
    }
  };

  return (
    <TabBody tab={tab}>
      {(face) => (
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                {...attributes}
                {...listeners}
                ref={(element) => {
                  setNodeRef(element);
                  elementRef.current = element;
                }}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                className="circe-worktab"
                data-active={active ? "true" : undefined}
                data-preview={tab.kept ? undefined : "true"}
                data-dragging={isDragging ? "true" : undefined}
                data-tab-id={tab.id}
                style={{ transform: CSS.Translate.toString(transform), transition }}
                onClick={() => onActivate(tab)}
                onDoubleClick={() => keep(tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1 && closable) {
                    event.preventDefault();
                    onClose(tab.id);
                  }
                }}
                onContextMenu={(event) => void handleContextMenu(event)}
                onKeyDown={handleKeyDown}
              />
            }
          >
            <TabUpkeep tabId={tab.id} face={face} active={active} />
            <span className="circe-worktab__icon" aria-hidden={face.tone === undefined}>
              {face.tone !== undefined ? (
                <CirceStatusGlyph tone={face.tone} label={face.toneLabel ?? ""} />
              ) : (
                face.icon
              )}
            </span>
            <span className="circe-worktab__title">{face.title}</span>
            {closable ? (
              <button
                type="button"
                className="circe-worktab__close"
                aria-label={`Close ${face.title}`}
                tabIndex={-1}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <XIcon />
              </button>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="bottom">{face.title}</TooltipPopup>
        </Tooltip>
      )}
    </TabBody>
  );
});

function NewTabMenu() {
  const { startChat, startAgentThread } = useStartNewWork();
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<button type="button" className="circe-worktab-new" aria-label="New tab" />}
            />
          }
        >
          <PlusIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">New</TooltipPopup>
      </Tooltip>
      <MenuPopup side="bottom" align="start" className="min-w-48">
        {startChat !== null ? (
          <MenuItem onClick={startChat}>
            <MessageCircleIcon />
            New chat
          </MenuItem>
        ) : null}
        <MenuItem onClick={startAgentThread}>
          <SquarePenIcon />
          New agent thread
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The row of open tabs above the page. It is the window's title bar on the
 * desktop, so the gaps between tabs drag the window and the ends leave room
 * for the native window controls.
 */
export function WorkspaceTabStrip() {
  const router = useRouter();
  const tabs = useWorkspaceTabsStore((store) => store.tabs);
  const activeTabId = useWorkspaceTabsStore((store) => store.activeTabId);
  const move = useWorkspaceTabsStore((store) => store.move);
  const close = useWorkspaceTabsStore((store) => store.close);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const activate = useCallback(
    (tab: WorkspaceTab) => {
      if (useWorkspaceTabsStore.getState().activeTabId !== tab.id) router.history.push(tab.href);
    },
    [router],
  );
  const closeAndFollow = useCallback(
    (tabId: string) => {
      const next = close(tabId);
      if (next !== null) router.history.push(next);
    },
    [close, router],
  );
  const step = useCallback(
    (offset: number) => {
      const next = tabAtOffset(useWorkspaceTabsStore.getState(), offset);
      if (next === null) return;
      activate(next);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-tab-id="${next.id}"]`)?.focus();
      });
    },
    [activate],
  );
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (event.over !== null && event.active.id !== event.over.id) {
        move(String(event.active.id), String(event.over.id));
      }
    },
    [move],
  );

  // Home alone has nothing to fall back to, so it stays.
  const soleHome = tabs.length === 1 && tabs[0]!.key === "page:home";

  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "tab.close" && command !== "tab.next" && command !== "tab.previous") return;
      event.preventDefault();
      event.stopPropagation();
      const state = useWorkspaceTabsStore.getState();
      if (command === "tab.close") {
        const onlyHome = state.tabs.length === 1 && state.tabs[0]!.key === "page:home";
        if (state.activeTabId !== null && !onlyHome) closeAndFollow(state.activeTabId);
        return;
      }
      const next = tabAtOffset(state, command === "tab.next" ? 1 : -1);
      if (next !== null) activate(next);
    };
    // Capture, so a focused editor does not swallow Ctrl+Tab as a tab character.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activate, closeAndFollow, keybindings]);

  return (
    <div className={cn("circe-tabstrip", isElectron && "drag-region")} data-workspace-tabstrip="">
      <Tooltip>
        <TooltipTrigger
          render={<SidebarTrigger className="circe-tabstrip__toggle" aria-label="Toggle sidebar" />}
        />
        <TooltipPopup side="bottom">Toggle sidebar</TooltipPopup>
      </Tooltip>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={tabs.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
          <div role="tablist" aria-label="Open tabs" className="circe-tabstrip__tabs">
            {tabs.map((tab) => (
              <WorkspaceTabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                closable={!soleHome}
                onActivate={activate}
                onClose={closeAndFollow}
                onStep={step}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <NewTabMenu />
    </div>
  );
}
