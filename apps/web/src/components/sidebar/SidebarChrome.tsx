import { ArrowLeftIcon, SettingsIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { Link, useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
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
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { CIRCE_MARK_SRC } from "../circe/CirceBrand";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  // The workbench header stays flat: environment stage shows as a quiet pill
  // on a crisp 1px rule, never as backdrop artwork.
  const pillLabel = resolveEnvironmentIdentificationPillLabel(stageLabel);

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center border-b border-sidebar-border px-3 py-0 md:px-0",
        isElectron && "drag-region",
      )}
    >
      <SidebarTrigger className="relative z-10 md:hidden" />
      <SidebarBrand />
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

function SidebarBrand() {
  return (
    <Link
      aria-label="Go home"
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-8 w-fit min-w-0 shrink-0 items-center gap-2.5 overflow-hidden rounded-[var(--control-radius)] pe-1.5 text-foreground outline-hidden ring-ring focus-visible:ring-2 md:flex"
      to="/"
    >
      <img alt="" className="size-5 shrink-0" src={CIRCE_MARK_SRC} />
      <span className="truncate text-[15px] font-semibold tracking-[-0.015em] text-foreground">
        Circe
      </span>
    </Link>
  );
}

/**
 * The sidebar's footer control: Settings everywhere, and Back while inside
 * Settings, which swaps the thread list for its own navigation.
 */
export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const onSettings = useLocation({
    select: (location) => /^\/settings(?:\/|$)/.test(location.pathname),
  });
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);
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
      <SidebarMenuItem className="min-w-0 flex-1">
        {onSettings ? (
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        ) : (
          <SidebarMenuButton onClick={handleSettingsClick}>
            <SettingsIcon />
            <span>Settings</span>
          </SidebarMenuButton>
        )}
      </SidebarMenuItem>
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="px-[var(--sidebar-content-inset)] py-1">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
