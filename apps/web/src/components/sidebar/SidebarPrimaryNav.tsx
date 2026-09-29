import { Link, useLocation } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, HouseIcon, MonitorSmartphoneIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { getCirceCommandState, onCirceCommandState } from "../../circeBus";
import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { isMacPlatform } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { usePullRequestsSupported } from "../../state/environments";
import { countCirceTasksNeedingYou } from "../circe/CirceHome.logic";
import { getCirceLiveVoiceUiState, subscribeCirceLiveVoice } from "../circe/CirceLiveVoice.bridge";
import { CirceOrb, type CirceOrbState } from "../circe/CirceOrb";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

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
  icon,
  label,
  active,
  trailing,
  link,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly active: boolean;
  readonly trailing?: ReactNode;
  readonly link: ReactElement;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        render={link}
        aria-current={active ? "page" : undefined}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
        }}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The app's destinations, always visible at the top of the sidebar. Home
 * carries Circe's presence and how many tasks wait on the user; the thread
 * list below stays the way to jump between conversations.
 */
export function SidebarPrimaryNav() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const pullRequestsSupported = usePullRequestsSupported();
  const presence = useCircePresence();
  const threads = useThreadShells();
  const now = useNowMinute();
  const needsYou = useMemo(() => countCirceTasksNeedingYou({ threads, now }), [now, threads]);
  // Desktop binds the chord to global voice, so the hint is web-only.
  const homeShortcut = isElectron ? null : isMacPlatform(navigator.platform) ? "⌘⇧J" : "Ctrl⇧J";

  return (
    <SidebarMenu aria-label="Main" className="gap-px">
      <NavItem
        icon={presence === "idle" ? <HouseIcon /> : <CirceOrb state={presence} size="xs" />}
        label="Home"
        active={pathname === "/"}
        link={<Link to="/" />}
        trailing={
          needsYou > 0 ? (
            <span className="circe-nav-badge" aria-label={`${needsYou} need you`}>
              {needsYou}
            </span>
          ) : homeShortcut ? (
            <kbd className="circe-nav-kbd">{homeShortcut}</kbd>
          ) : null
        }
      />
      {pullRequestsSupported ? (
        <NavItem
          icon={<PullRequestGlyph.pullRequest />}
          label="Pull requests"
          active={pathname === "/pull-requests"}
          link={<Link to="/pull-requests" search={readPullRequestListPreferences()} />}
        />
      ) : null}
      <NavItem
        icon={<MonitorSmartphoneIcon />}
        label="Machines"
        active={pathname === "/machines"}
        link={<Link to="/machines" />}
      />
      <NavItem
        icon={<ChartNoAxesColumnIcon />}
        label="Usage"
        active={pathname === "/usage"}
        link={<Link to="/usage" />}
      />
    </SidebarMenu>
  );
}
