import { ArrowLeftIcon } from "lucide-react";
import { memo, useCallback, type ReactNode } from "react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

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
  useSidebar,
} from "../ui/sidebar";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

/**
 * The context sidebar's title bar: the list's name, the environment stage pill,
 * and that list's own actions. The brand lives on the rail. On macOS the
 * traffic lights reach past the rail, so the title starts after them.
 */
export const SidebarPanelHeader = memo(function SidebarPanelHeader({
  isElectron,
  title,
  actions,
}: {
  isElectron: boolean;
  title: string;
  actions?: ReactNode;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const pillLabel = resolveEnvironmentIdentificationPillLabel(stageLabel);

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 border-b border-sidebar-border py-0 pe-2 ps-3 md:ps-[max(0.875rem,calc(var(--workspace-controls-left)-var(--app-rail-width)))]",
        isElectron && "drag-region",
      )}
    >
      <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-sidebar-foreground">
        {title}
      </h2>
      {pillLabel ? (
        <Badge
          className="hidden px-1.5 text-muted-foreground @[14rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
      {actions ? (
        <div className="ms-auto flex items-center gap-0.5 [-webkit-app-region:no-drag]">
          {actions}
        </div>
      ) : null}
    </SidebarHeader>
  );
});

/** Back out of Settings, which swaps the thread list for its own navigation. */
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

/** Update notices; they render nothing when there is nothing to update. */
export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="px-[var(--sidebar-content-inset)] py-1 empty:hidden">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <div className="flex justify-end empty:hidden">
        <SidebarUpdatePill />
      </div>
    </SidebarFooter>
  );
});
