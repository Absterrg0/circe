import { isChatWorkspace } from "@circe/contracts";
import { useAuth } from "@clerk/react";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import {
  BotIcon,
  ChartNoAxesColumnIcon,
  FolderPlusIcon,
  HouseIcon,
  LogInIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MonitorSmartphoneIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
  SquareTerminalIcon,
} from "lucide-react";
import {
  cloneElement,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { create } from "zustand";

import { getCirceCommandState, onCirceCommandState } from "../../circeBus";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useStartNewWork } from "../../hooks/useStartNewWork";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShell, useThreadShells } from "../../state/entities";
import { usePullRequestsSupported } from "../../state/environments";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { CIRCE_MARK_SRC } from "../circe/CirceBrand";
import { countCirceTasksNeedingYou } from "../circe/CirceHome.logic";
import { getCirceLiveVoiceUiState, subscribeCirceLiveVoice } from "../circe/CirceLiveVoice.bridge";
import { CirceOrb, type CirceOrbState } from "../circe/CirceOrb";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  resolveRailPage,
  resolveRailPanelClick,
  resolveRouteRailPanel,
  type RailPage,
  type RailPanel,
} from "./appRail.logic";

/** The list the context sidebar shows. Routes with a list of their own set it. */
export const useRailPanelStore = create<{
  readonly panel: RailPanel;
  readonly setPanel: (panel: RailPanel) => void;
}>((set) => ({ panel: "agents", setPanel: (panel) => set({ panel }) }));

/** Whether the thread or draft on screen is a chat; null off thread routes. */
function useRouteThreadIsChat(): boolean | null {
  const target = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const thread = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    target?.kind === "draft" ? store.getDraftSession(target.draftId) : null,
  );
  const projects = useProjects();
  const owner = thread ?? draft;
  if (owner === null || owner === undefined) return null;
  const workspace = projects.find(
    (project) => project.environmentId === owner.environmentId && project.id === owner.projectId,
  );
  return workspace === undefined ? null : isChatWorkspace(workspace);
}

/** Keeps the context sidebar on the list the current route belongs to. */
export function useRouteRailPanelSync(): void {
  const pathname = useLocation({ select: (location) => location.pathname });
  const routePanel = resolveRouteRailPanel(pathname, useRouteThreadIsChat());
  const setPanel = useRailPanelStore((store) => store.setPanel);
  useEffect(() => {
    if (routePanel !== null) setPanel(routePanel);
  }, [routePanel, setPanel]);
}

/** Circe's live presence from the same buses Home reads. */
function useCircePresence(): CirceOrbState {
  const [voice, setVoice] = useState(getCirceLiveVoiceUiState);
  const [command, setCommand] = useState(getCirceCommandState);
  useEffect(() => subscribeCirceLiveVoice(() => setVoice(getCirceLiveVoiceUiState())), []);
  useEffect(() => onCirceCommandState(setCommand), []);
  return voice.active && voice.status === "live"
    ? "listening"
    : command.busy
      ? "working"
      : command.awaitingAnswer
        ? "attention"
        : "idle";
}

type Orientation = "vertical" | "horizontal";

const RailAccountAvatar = lazy(() =>
  import("../clerk/T3ConnectSidebarSignIn").then((module) => ({
    default: module.T3ConnectSidebarAvatar,
  })),
);

/**
 * Persistent sign-in state at the rail's bottom: the account avatar when
 * signed in, a sign-in action when not. The full account management stays in
 * Settings; this only answers "am I signed in?" from every panel.
 */
function ConfiguredRailAccountButton({ orientation }: { readonly orientation: Orientation }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  if (!isLoaded) return null;
  if (isSignedIn) {
    return (
      <div className="circe-rail-account" title="Signed in to Circe Mesh">
        <Suspense fallback={null}>
          <RailAccountAvatar />
        </Suspense>
      </div>
    );
  }
  return (
    <RailButton
      orientation={orientation}
      label="Sign in to Circe Mesh"
      icon={<LogInIcon />}
      onClick={openAuthPrompt}
    />
  );
}

function RailAccountButton({ orientation }: { readonly orientation: Orientation }) {
  if (!hasCloudPublicConfig()) return null;
  return <ConfiguredRailAccountButton orientation={orientation} />;
}

function RailButton({
  label,
  icon,
  current = false,
  panelShown = false,
  badge,
  link,
  onClick,
  orientation,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  /** The page on screen. */
  readonly current?: boolean;
  /** Its list is open in the context sidebar. */
  readonly panelShown?: boolean;
  readonly badge?: number;
  readonly link?: ReactElement;
  readonly onClick?: () => void;
  readonly orientation: Orientation;
}) {
  const className = "circe-rail-button";
  const content = (
    <>
      {icon}
      {badge !== undefined && badge > 0 ? (
        <span className="circe-rail-badge" aria-hidden>
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </>
  );
  const accessibleLabel = badge !== undefined && badge > 0 ? `${label}, ${badge} need you` : label;
  const shared = {
    className,
    "aria-label": accessibleLabel,
    "data-current": current ? "true" : undefined,
    "data-panel": panelShown ? "true" : undefined,
    "aria-current": current ? ("page" as const) : undefined,
    // Links carry their own click handler; overriding it with undefined would drop it.
    ...(onClick === undefined ? {} : { onClick }),
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={link ? cloneElement(link, shared) : <button type="button" {...shared} />}
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup side={orientation === "vertical" ? "right" : "bottom"}>{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The app's icon rail: pages (Home, Pull requests, Machines, Usage, Settings)
 * navigate, and lists (Agents, Chats, Bots) switch the context sidebar beside
 * it. On desktop it is always visible; on narrow windows it runs across the
 * top of the sidebar sheet.
 */
export function AppRail({
  orientation = "vertical",
  reserveTitlebar = false,
}: {
  readonly orientation?: Orientation;
  /** Leave the top clear for macOS traffic lights. */
  readonly reserveTitlebar?: boolean;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const page: RailPage | null = resolveRailPage(pathname);
  const panel = useRailPanelStore((store) => store.panel);
  const setPanel = useRailPanelStore((store) => store.setPanel);
  const { open, setOpen, isMobile, openMobile, setOpenMobile } = useSidebar();
  const sidebarOpen = isMobile ? openMobile : open;
  const pullRequestsSupported = usePullRequestsSupported();
  const presence = useCircePresence();
  const threads = useThreadShells();
  const now = useNowMinute();
  const needsYou = useMemo(() => countCirceTasksNeedingYou({ threads, now }), [now, threads]);
  const { startChat, startAgentThread, addProject } = useStartNewWork();

  const closeSheet = () => {
    if (isMobile) setOpenMobile(false);
  };
  const showPanel = (clicked: RailPanel) => {
    const next = resolveRailPanelClick({ clicked, shown: panel, sidebarOpen });
    setPanel(next.panel);
    if (isMobile) {
      // The sheet is the only place the list shows on narrow windows.
      setOpenMobile(true);
    } else {
      void setOpen(next.sidebarOpen);
    }
  };
  const panelShown = (candidate: RailPanel) => sidebarOpen && panel === candidate;

  return (
    <nav
      aria-label="Circe"
      className={cn("circe-rail", orientation === "horizontal" && "circe-rail--horizontal")}
      data-reserve-titlebar={reserveTitlebar ? "true" : undefined}
    >
      {orientation === "vertical" ? (
        <div className="circe-rail__top">
          <Link to="/" className="circe-rail__logo" aria-label="Circe home" onClick={closeSheet}>
            <img alt="" src={CIRCE_MARK_SRC} />
          </Link>
        </div>
      ) : null}
      <div className="circe-rail__group">
        <RailButton
          orientation={orientation}
          label="Home"
          icon={presence === "idle" ? <HouseIcon /> : <CirceOrb state={presence} size="sm" />}
          current={page === "home"}
          badge={needsYou}
          link={<Link to="/" onClick={closeSheet} />}
        />
        <RailButton
          orientation={orientation}
          label="Bots"
          icon={<BotIcon />}
          current={page === null && panel === "bots"}
          panelShown={panelShown("bots")}
          onClick={() => showPanel("bots")}
        />
        <RailButton
          orientation={orientation}
          label="Agents"
          icon={<SquareTerminalIcon />}
          current={page === null && panel === "agents"}
          panelShown={panelShown("agents")}
          onClick={() => showPanel("agents")}
        />
        <RailButton
          orientation={orientation}
          label="Chats"
          icon={<MessagesSquareIcon />}
          current={page === null && panel === "chats"}
          panelShown={panelShown("chats")}
          onClick={() => showPanel("chats")}
        />
        {pullRequestsSupported ? (
          <RailButton
            orientation={orientation}
            label="Pull requests"
            icon={<PullRequestGlyph.pullRequest />}
            current={page === "pull-requests"}
            link={
              <Link
                to="/pull-requests"
                search={readPullRequestListPreferences()}
                onClick={closeSheet}
              />
            }
          />
        ) : null}
      </div>
      <div className="circe-rail__group circe-rail__group--end">
        <RailButton
          orientation={orientation}
          label="Machines"
          icon={<MonitorSmartphoneIcon />}
          current={page === "machines"}
          panelShown={panelShown("machines")}
          link={<Link to="/machines" onClick={closeSheet} />}
        />
        <RailButton
          orientation={orientation}
          label="Usage"
          icon={<ChartNoAxesColumnIcon />}
          current={page === "usage"}
          link={<Link to="/usage" onClick={closeSheet} />}
        />
        <Menu>
          <MenuTrigger
            render={
              <button type="button" className="circe-rail-new" aria-label="New" title="New" />
            }
          >
            <PlusIcon />
          </MenuTrigger>
          <MenuPopup
            side={orientation === "vertical" ? "right" : "bottom"}
            align="end"
            className="min-w-52"
          >
            <MenuItem
              disabled={startChat === null}
              onClick={() => {
                closeSheet();
                startChat?.();
              }}
            >
              <MessageCircleIcon />
              New chat
            </MenuItem>
            <MenuItem
              onClick={() => {
                closeSheet();
                startAgentThread();
              }}
            >
              <SquarePenIcon />
              New agent thread
            </MenuItem>
            <MenuItem onClick={addProject}>
              <FolderPlusIcon />
              Add project
            </MenuItem>
          </MenuPopup>
        </Menu>
        {orientation === "vertical" ? (
          <RailButton
            orientation={orientation}
            label={open ? "Hide sidebar" : "Show sidebar"}
            icon={open ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
            onClick={() => void setOpen(!open)}
          />
        ) : null}
        <RailButton
          orientation={orientation}
          label="Settings"
          icon={<SettingsIcon />}
          current={page === "settings"}
          panelShown={panelShown("settings")}
          link={<Link to="/settings" />}
        />
        <RailAccountButton orientation={orientation} />
      </div>
    </nav>
  );
}
