import { Link, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  ChevronRightIcon,
  HouseIcon,
  MonitorSmartphoneIcon,
  SettingsIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { getCirceCommandState, onCirceCommandState } from "../../circeBus";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { usePullRequestsSupported } from "../../state/environments";
import { resolveTabTarget, type WorkspacePage } from "../../workspaceTabs.logic";
import { CIRCE_MARK_SRC } from "../circe/CirceBrand";
import { countCirceTasksNeedingYou } from "../circe/CirceHome.logic";
import { getCirceLiveVoiceUiState, subscribeCirceLiveVoice } from "../circe/CirceLiveVoice.bridge";
import { CirceOrb, type CirceOrbState } from "../circe/CirceOrb";
import { CirceWordmark } from "../CirceWordmark";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

/**
 * The sidebar's top row: the brand, which leads Home, and the environment
 * stage pill. It lines up with the tab strip and drags the window on the
 * desktop. On macOS the traffic lights sit over its start.
 */
export const SidebarBrandHeader = memo(function SidebarBrandHeader({
  isElectron,
  title,
}: {
  isElectron: boolean;
  /** Names the sidebar when it shows something other than the workspace. */
  title?: string;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const pillLabel = resolveEnvironmentIdentificationPillLabel(stageLabel);
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--app-tabstrip-height)] shrink-0 flex-row items-center gap-2 py-0 pe-2 ps-3 md:ps-[max(0.75rem,var(--workspace-controls-left))]",
        isElectron && "drag-region",
      )}
    >
      {title === undefined ? (
        <Link
          to="/"
          className="circe-sidebar-brand"
          aria-label="Circe home"
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <span className="circe-sidebar-brand__mark">
            <img alt="" src={CIRCE_MARK_SRC} />
          </span>
          <CirceWordmark className="text-[12.5px] text-sidebar-foreground" />
        </Link>
      ) : (
        <h2 className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-sidebar-foreground">
          {title}
        </h2>
      )}
      {pillLabel ? (
        <Badge
          className="hidden px-1.5 text-muted-foreground @[12rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

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

function NavItem({
  label,
  icon,
  current,
  badge,
  link,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly current: boolean;
  readonly badge?: number;
  readonly link: ReactElement;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={current}
        aria-current={current ? "page" : undefined}
        className="circe-sidebar-nav-item"
        render={link}
      >
        {icon}
        <span className="truncate">{label}</span>
        {badge !== undefined && badge > 0 ? (
          <span className="circe-sidebar-nav-badge" aria-label={`${badge} need you`}>
            {badge > 9 ? "9+" : badge}
          </span>
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The workspace's pages. Home carries Circe's presence and the needs-you
 * count, so there is no separate launcher.
 */
export const SidebarPrimaryNav = memo(function SidebarPrimaryNav() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const target = resolveTabTarget(pathname);
  const page: WorkspacePage | null = target?.kind === "page" ? target.page : null;
  const pullRequestsSupported = usePullRequestsSupported();
  const presence = useCircePresence();
  const threads = useThreadShells();
  const now = useNowMinute();
  const needsYou = useMemo(() => countCirceTasksNeedingYou({ threads, now }), [now, threads]);
  const { isMobile, setOpenMobile } = useSidebar();
  const closeSheet = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <SidebarMenu aria-label="Pages" className="gap-px ps-px">
      <NavItem
        label="Home"
        icon={presence === "idle" ? <HouseIcon /> : <CirceOrb state={presence} size="sm" />}
        current={page === "home"}
        badge={needsYou}
        link={<Link to="/" onClick={closeSheet} />}
      />
      {pullRequestsSupported ? (
        <NavItem
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
      <NavItem
        label="Machines"
        icon={<MonitorSmartphoneIcon />}
        current={page === "machines"}
        link={<Link to="/machines" onClick={closeSheet} />}
      />
      <NavItem
        label="Usage"
        icon={<ChartNoAxesColumnIcon />}
        current={page === "usage"}
        link={<Link to="/usage" onClick={closeSheet} />}
      />
    </SidebarMenu>
  );
});

/**
 * A list's heading inside the sidebar, with that list's own actions. Give it
 * `collapsed` and `onToggle` to let the heading fold the list.
 */
export function SidebarSectionTitle({
  title,
  count,
  actions,
  collapsed,
  onToggle,
}: {
  readonly title: string;
  readonly count?: number;
  readonly actions?: ReactNode;
  readonly collapsed?: boolean;
  readonly onToggle?: () => void;
}) {
  const label = (
    <>
      <span>{title}</span>
      {count !== undefined && count > 0 ? (
        <span className="circe-sidebar-section__count">{count}</span>
      ) : null}
    </>
  );
  return (
    <div className="circe-sidebar-section">
      {onToggle === undefined ? (
        <h3 className="circe-sidebar-section__title">{label}</h3>
      ) : (
        <h3 className="min-w-0">
          <button
            type="button"
            className="circe-sidebar-section__title circe-sidebar-section__toggle"
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            {label}
            <ChevronRightIcon aria-hidden data-open={collapsed ? undefined : "true"} />
          </button>
        </h3>
      )}
      {actions ? <div className="circe-sidebar-section__actions">{actions}</div> : null}
    </div>
  );
}

/** Back out of Settings, which swaps the workspace sidebar for its own navigation. */
export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleBackClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenu className="flex-row items-center">
      <SidebarMenuItem className="min-w-0 flex-1">
        <SidebarMenuButton onClick={handleBackClick}>
          <ArrowLeftIcon />
          <span>Back</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

/** Update notices, when there are any, over the way into Settings. */
export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarFooter className="gap-1 px-[var(--sidebar-content-inset)] py-1.5">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarMenu className="flex-row items-center ps-px">
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton
            className="circe-sidebar-nav-item"
            render={
              <Link
                to="/settings"
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                }}
              />
            }
          >
            <SettingsIcon />
            <span className="truncate">Settings</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarUpdatePill />
      </SidebarMenu>
    </SidebarFooter>
  );
});
