import { describe, expect, it } from "vite-plus/test";

import { resolveRailPage, resolveRailPanelClick, resolveRouteRailPanel } from "./appRail.logic";

describe("resolveRouteRailPanel", () => {
  it("shows the list a route belongs to", () => {
    expect(resolveRouteRailPanel("/settings/general", null)).toBe("settings");
    expect(resolveRouteRailPanel("/machines", null)).toBe("machines");
    expect(resolveRouteRailPanel("/bots/env-1/bot-1", null)).toBe("bots");
    expect(resolveRouteRailPanel("/env-1/thread-1", true)).toBe("chats");
    expect(resolveRouteRailPanel("/env-1/thread-1", false)).toBe("agents");
  });

  it("keeps the user's choice on pages without a list", () => {
    expect(resolveRouteRailPanel("/", null)).toBeNull();
    expect(resolveRouteRailPanel("/pull-requests", null)).toBeNull();
    expect(resolveRouteRailPanel("/usage", null)).toBeNull();
  });
});

describe("resolveRailPage", () => {
  it("marks page destinations and leaves threads and bots to their list", () => {
    expect(resolveRailPage("/")).toBe("home");
    expect(resolveRailPage("/pull-requests")).toBe("pull-requests");
    expect(resolveRailPage("/machines")).toBe("machines");
    expect(resolveRailPage("/usage")).toBe("usage");
    expect(resolveRailPage("/settings/providers")).toBe("settings");
    expect(resolveRailPage("/env-1/thread-1")).toBeNull();
    expect(resolveRailPage("/bots/env-1/bot-1")).toBeNull();
  });
});

describe("resolveRailPanelClick", () => {
  it("opens the clicked list", () => {
    expect(resolveRailPanelClick({ clicked: "bots", shown: "agents", sidebarOpen: true })).toEqual({
      panel: "bots",
      sidebarOpen: true,
    });
    expect(
      resolveRailPanelClick({ clicked: "agents", shown: "agents", sidebarOpen: false }),
    ).toEqual({ panel: "agents", sidebarOpen: true });
  });

  it("closes the sidebar when the shown list is clicked again", () => {
    expect(resolveRailPanelClick({ clicked: "chats", shown: "chats", sidebarOpen: true })).toEqual({
      panel: "chats",
      sidebarOpen: false,
    });
  });
});
