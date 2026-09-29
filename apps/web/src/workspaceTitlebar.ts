/**
 * Header padding for when nothing sits between the window's left edge and the
 * page. On desktop the icon rail is always there, so only macOS traffic
 * lights that reach past it need room; narrow windows have no rail and show
 * the floating sidebar toggle instead.
 */
export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "md:[[data-sidebar-state=collapsed]_&]:pl-[max(1.25rem,calc(var(--workspace-controls-left)-var(--app-rail-width)+0.75rem))] max-md:pl-[var(--workspace-titlebar-content-left)]";
