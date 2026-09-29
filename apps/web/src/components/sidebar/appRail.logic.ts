/** Lists the context sidebar can show beside the rail. */
export type RailPanel = "agents" | "chats" | "bots" | "machines" | "settings";

/** Rail destinations that are pages of their own. */
export type RailPage = "home" | "pull-requests" | "machines" | "usage" | "settings";

const BOT_ROUTE = /^\/bots\/[^/]+\/[^/]+\/?$/;

/**
 * The list a route belongs to, so opening a chat shows Chats and opening a
 * bot shows Bots. Home, Pull requests, and Usage have no list of their own
 * and keep whatever the user last chose. `routeThreadIsChat` is null when the
 * route is not a thread or its workspace has not loaded.
 */
export function resolveRouteRailPanel(
  pathname: string,
  routeThreadIsChat: boolean | null,
): RailPanel | null {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/machines") return "machines";
  if (BOT_ROUTE.test(pathname)) return "bots";
  if (routeThreadIsChat === null) return null;
  return routeThreadIsChat ? "chats" : "agents";
}

/** The page a route is, for the rail's current marker; null for threads and bots. */
export function resolveRailPage(pathname: string): RailPage | null {
  if (pathname === "/") return "home";
  if (pathname === "/pull-requests") return "pull-requests";
  if (pathname === "/machines") return "machines";
  if (pathname === "/usage") return "usage";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  return null;
}

/**
 * What a click on a list's rail icon does: open that list, or close the
 * sidebar when that list is already showing, as an activity bar does.
 */
export function resolveRailPanelClick(input: {
  readonly clicked: RailPanel;
  readonly shown: RailPanel;
  readonly sidebarOpen: boolean;
}): { readonly panel: RailPanel; readonly sidebarOpen: boolean } {
  if (input.sidebarOpen && input.clicked === input.shown) {
    return { panel: input.shown, sidebarOpen: false };
  }
  return { panel: input.clicked, sidebarOpen: true };
}
