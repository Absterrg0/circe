import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  ChevronDownIcon,
  LayersIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import {
  useEnvironmentConnectionSummaries,
  useEnvironmentMachines,
  usePullRequestsSupported,
} from "../../state/environments";
import { useUiStateStore } from "../../uiStateStore";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
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
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { CIRCE_MARK_SRC } from "../circe/CirceBrand";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  title = "Tasks",
  showMachineScope = false,
}: {
  isElectron: boolean;
  /** Desktop title for what the rail points at; the brand lives on the rail there. */
  title?: string;
  showMachineScope?: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  // The workbench header stays flat: environment stage shows as a quiet pill
  // on a crisp 1px rule, never as backdrop artwork.
  const pillLabel = resolveEnvironmentIdentificationPillLabel(stageLabel);

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-1 px-3 py-0 max-md:border-b max-md:border-sidebar-border md:ps-4 md:pe-2",
        isElectron && "drag-region",
      )}
    >
      <SidebarTrigger className="relative z-10 md:hidden" />
      <SidebarBrand />
      <span className="relative z-10 hidden font-display text-base font-semibold tracking-[-0.02em] text-sidebar-foreground md:inline">
        {title}
      </span>
      {showMachineScope ? <SidebarMachineScope /> : null}
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden px-1.5 text-muted-foreground @[15rem]/sidebar-header:inline-flex"
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

/**
 * The machine scope the rail tiles set, as a chip that names it. Scoping hides
 * other machines' tasks, so the header always says which machine is showing.
 */
function SidebarMachineScope() {
  const environments = useEnvironmentConnectionSummaries();
  const machineById = useEnvironmentMachines();
  const scope = useUiStateStore((store) => store.sidebarMachineScope);
  const setScope = useUiStateStore((store) => store.setSidebarMachineScope);
  const enabled = environments.filter((env) => env.isEnabled);
  if (enabled.length < 2 && scope === null) return null;
  const scoped = enabled.find((env) => env.environmentId === scope) ?? null;
  return (
    <Menu>
      <MenuTrigger
        className="relative z-10 ml-1 hidden h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-sidebar-muted-foreground outline-none transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
        aria-label="Machine scope"
      >
        {scoped ? scoped.environmentLabel : "All machines"}
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-56">
        <MenuRadioGroup
          value={scope ?? "all"}
          onValueChange={(value) => setScope(value === "all" ? null : String(value))}
        >
          <MenuRadioItem value="all">
            <span className="flex items-center gap-2">
              <LayersIcon className="size-3.5 opacity-70" />
              All machines
            </span>
          </MenuRadioItem>
          {enabled.map((env) => (
            <MenuRadioItem key={env.environmentId} value={env.environmentId}>
              <span className="flex min-w-0 items-center gap-2">
                <EnvironmentMachineIcon
                  kind={machineById.get(env.environmentId) ?? "server"}
                  className="size-3.5 opacity-70"
                />
                <span className="min-w-0 truncate">{env.environmentLabel}</span>
                {env.connectionState !== "connected" ? (
                  <span className="text-xs text-muted-foreground">offline</span>
                ) : null}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function SidebarBrand() {
  return (
    <Link
      aria-label="Go to threads"
      className="relative z-10 flex h-8 w-fit min-w-0 shrink-0 items-center gap-2.5 overflow-hidden rounded-[var(--control-radius)] pe-1.5 text-foreground outline-hidden ring-ring focus-visible:ring-2 md:hidden"
      to="/"
    >
      <img alt="" className="size-5 shrink-0" src={CIRCE_MARK_SRC} />
      <span className="truncate font-display text-[15px] font-semibold tracking-[-0.015em] text-foreground">
        Circe
      </span>
    </Link>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/usage"
            ? "usage"
            : location.pathname === "/circe"
              ? "circe"
              : location.pathname === "/pull-requests"
                ? "pull-requests"
                : null,
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  }, [closeMobileSidebar, navigate]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleCirceClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/circe" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  return (
    <SidebarMenu className="flex-row items-center">
      {currentFooterPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<img alt="" className="size-4 rounded-sm" src={CIRCE_MARK_SRC} />}
            label="Circe Control Center"
            onClick={handleCirceClick}
          />
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="px-[var(--sidebar-content-inset)] py-1">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <div className="md:hidden">
        <SidebarUtilityMenu />
      </div>
      <div className="hidden empty:hidden md:block">
        <SidebarUpdatePill />
      </div>
    </SidebarFooter>
  );
});
