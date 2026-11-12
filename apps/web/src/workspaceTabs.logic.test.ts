import { describe, expect, it } from "vite-plus/test";

import {
  addBackgroundTab,
  closeOtherTabs,
  closeTab,
  closeTabsByKey,
  closeTabsToRight,
  EMPTY_WORKSPACE_TABS,
  isInPlaceNavigation,
  keepTab,
  moveTab,
  openTabLocation,
  replaceActiveTabLocation,
  resolveTabKey,
  resolveTabTarget,
  sanitizePersistedTabs,
  tabAtOffset,
  type WorkspaceTabsState,
} from "./workspaceTabs.logic";

const home = { key: "page:home", href: "/" };
const threadA = { key: "thread:env/a", href: "/env/a" };
const threadB = { key: "thread:env/b", href: "/env/b" };
const threadC = { key: "thread:env/c", href: "/env/c" };

/** Opens each location in turn and keeps it, so every tab stays. */
function keptTabs(...locations: ReadonlyArray<{ key: string; href: string }>): WorkspaceTabsState {
  return locations.reduce<WorkspaceTabsState>((state, location, index) => {
    const opened = openTabLocation(state, location, `t${index}`);
    return keepTab(opened, opened.activeTabId!);
  }, EMPTY_WORKSPACE_TABS);
}

const keys = (state: WorkspaceTabsState) => state.tabs.map((tab) => tab.key);
const activeKey = (state: WorkspaceTabsState) =>
  state.tabs.find((tab) => tab.id === state.activeTabId)?.key ?? null;

describe("resolveTabTarget", () => {
  it("names each workspace place", () => {
    expect(resolveTabKey("/")).toBe("page:home");
    expect(resolveTabKey("/pull-requests")).toBe("page:pull-requests");
    expect(resolveTabKey("/machines")).toBe("page:machines");
    expect(resolveTabKey("/usage")).toBe("page:usage");
    expect(resolveTabKey("/env-1/thread-1")).toBe("thread:env-1/thread-1");
    expect(resolveTabKey("/draft/d1")).toBe("draft:d1");
    expect(resolveTabKey("/bots/env-1/bot-1")).toBe("bot:env-1/bot-1");
  });

  it("treats every Settings page as one place", () => {
    expect(resolveTabKey("/settings")).toBe("page:settings");
    expect(resolveTabKey("/settings/providers")).toBe("page:settings");
    expect(resolveTabKey("/projects/some-key")).toBe("page:settings");
  });

  it("leaves routes outside the shell without a tab", () => {
    expect(resolveTabTarget("/pair")).toBeNull();
    expect(resolveTabTarget("/connect")).toBeNull();
    expect(resolveTabTarget("/welcome")).toBeNull();
  });

  it("decodes thread ids that carry reserved characters", () => {
    expect(resolveTabTarget("/env/thread%3Aproject%3Ax")).toEqual({
      kind: "thread",
      environmentId: "env",
      threadId: "thread:project:x",
    });
  });
});

describe("openTabLocation", () => {
  it("opens the first place as the active preview tab", () => {
    const state = openTabLocation(EMPTY_WORKSPACE_TABS, home, "t0");
    expect(state.tabs).toEqual([{ id: "t0", ...home, kept: false, label: null }]);
    expect(state.activeTabId).toBe("t0");
  });

  it("reuses the preview tab instead of adding one per click", () => {
    const first = openTabLocation(EMPTY_WORKSPACE_TABS, threadA, "t0");
    const second = openTabLocation(first, threadB, "t1");
    expect(keys(second)).toEqual([threadB.key]);
    expect(second.activeTabId).toBe("t0");
  });

  it("opens a preview beside the active tab once every tab is kept", () => {
    const state = openTabLocation(
      { ...keptTabs(threadA, threadB), activeTabId: "t0" },
      threadC,
      "t9",
    );
    expect(keys(state)).toEqual([threadA.key, threadC.key, threadB.key]);
    expect(activeKey(state)).toBe(threadC.key);
    expect(state.tabs[1]!.kept).toBe(false);
  });

  it("focuses a place that is already open and remembers its newest location", () => {
    const state = openTabLocation(
      keptTabs(threadA, threadB),
      { key: threadA.key, href: "/env/a?diff=1" },
      "t9",
    );
    expect(keys(state)).toEqual([threadA.key, threadB.key]);
    expect(activeKey(state)).toBe(threadA.key);
    expect(state.tabs[0]!.href).toBe("/env/a?diff=1");
  });

  it("returns the same state when nothing changes", () => {
    const state = keptTabs(threadA);
    expect(openTabLocation(state, threadA, "t9")).toBe(state);
  });

  it("clears the cached label when the preview shows a new place", () => {
    const first = openTabLocation(EMPTY_WORKSPACE_TABS, threadA, "t0");
    const labelled = { ...first, tabs: [{ ...first.tabs[0]!, label: "Thread A" }] };
    expect(openTabLocation(labelled, threadB, "t1").tabs[0]!.label).toBeNull();
  });
});

describe("replaceActiveTabLocation", () => {
  const draft = { key: "draft:d1", href: "/draft/d1" };

  it("keeps the tab's position and kept state when a draft becomes a thread", () => {
    const state = replaceActiveTabLocation(
      { ...keptTabs(threadA, draft, threadB), activeTabId: "t1" },
      threadC,
      "t9",
    );
    expect(keys(state)).toEqual([threadA.key, threadC.key, threadB.key]);
    expect(state.activeTabId).toBe("t1");
    expect(state.tabs[1]!.kept).toBe(true);
  });

  it("closes the active tab into an open tab for the same place", () => {
    const state = replaceActiveTabLocation(
      { ...keptTabs(home, threadA), activeTabId: "t1" },
      home,
      "t9",
    );
    expect(keys(state)).toEqual([home.key]);
    expect(activeKey(state)).toBe(home.key);
  });

  it("opens normally when no tab is active", () => {
    const state = replaceActiveTabLocation(EMPTY_WORKSPACE_TABS, home, "t0");
    expect(keys(state)).toEqual([home.key]);
  });
});

describe("addBackgroundTab", () => {
  it("adds a kept tab beside the active one without focusing it", () => {
    const state = addBackgroundTab(
      { ...keptTabs(threadA, threadB), activeTabId: "t0" },
      threadC,
      "t9",
    );
    expect(keys(state)).toEqual([threadA.key, threadC.key, threadB.key]);
    expect(state.activeTabId).toBe("t0");
    expect(state.tabs[1]!.kept).toBe(true);
  });

  it("keeps the preview tab when it already shows that place", () => {
    const preview = openTabLocation(EMPTY_WORKSPACE_TABS, threadA, "t0");
    const state = addBackgroundTab(preview, threadA, "t9");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.kept).toBe(true);
  });
});

describe("closing tabs", () => {
  it("hands the screen to the tab on the right, then the left", () => {
    const state = { ...keptTabs(threadA, threadB, threadC), activeTabId: "t1" };
    const closedMiddle = closeTab(state, "t1");
    expect(closedMiddle.navigateTo).toBe(threadC.href);
    expect(activeKey(closedMiddle.state)).toBe(threadC.key);

    const closedLast = closeTab({ ...state, activeTabId: "t2" }, "t2");
    expect(closedLast.navigateTo).toBe(threadB.href);
  });

  it("goes Home when the last tab closes", () => {
    const result = closeTab(keptTabs(threadA), "t0");
    expect(result.state).toEqual(EMPTY_WORKSPACE_TABS);
    expect(result.navigateTo).toBe("/");
  });

  it("does not navigate when a background tab closes", () => {
    const result = closeTab({ ...keptTabs(threadA, threadB), activeTabId: "t0" }, "t1");
    expect(result.navigateTo).toBeNull();
    expect(keys(result.state)).toEqual([threadA.key]);
  });

  it("closes the others around a tab and moves the screen to it", () => {
    const result = closeOtherTabs(
      { ...keptTabs(threadA, threadB, threadC), activeTabId: "t0" },
      "t1",
    );
    expect(keys(result.state)).toEqual([threadB.key]);
    expect(result.navigateTo).toBe(threadB.href);
  });

  it("closes only the tabs to the right", () => {
    const result = closeTabsToRight(
      { ...keptTabs(threadA, threadB, threadC), activeTabId: "t0" },
      "t0",
    );
    expect(keys(result.state)).toEqual([threadA.key]);
    expect(result.navigateTo).toBeNull();
  });

  it("closes the tab of a deleted thread wherever it sits", () => {
    const result = closeTabsByKey(
      { ...keptTabs(threadA, threadB), activeTabId: "t0" },
      new Set([threadB.key]),
    );
    expect(keys(result.state)).toEqual([threadA.key]);
    expect(result.navigateTo).toBeNull();
  });
});

describe("moveTab", () => {
  it("drops a tab at another tab's position and keeps it", () => {
    const preview = openTabLocation(keptTabs(threadA, threadB), threadC, "t9");
    const moved = moveTab(preview, "t9", "t0");
    expect(keys(moved)).toEqual([threadC.key, threadA.key, threadB.key]);
    expect(moved.tabs[0]!.kept).toBe(true);
  });
});

describe("tabAtOffset", () => {
  it("wraps in both directions", () => {
    const state = { ...keptTabs(threadA, threadB, threadC), activeTabId: "t2" };
    expect(tabAtOffset(state, 1)?.key).toBe(threadA.key);
    expect(tabAtOffset({ ...state, activeTabId: "t0" }, -1)?.key).toBe(threadC.key);
    expect(tabAtOffset(EMPTY_WORKSPACE_TABS, 1)).toBeNull();
  });
});

describe("isInPlaceNavigation", () => {
  it("is a replace that leaves the place the active tab was showing", () => {
    expect(
      isInPlaceNavigation({ action: "REPLACE", previousKey: "draft:d1", activeKey: "draft:d1" }),
    ).toBe(true);
  });

  it("is not a replace arriving from outside the shell or from another tab's place", () => {
    expect(
      isInPlaceNavigation({ action: "REPLACE", previousKey: null, activeKey: "thread:env/a" }),
    ).toBe(false);
    expect(
      isInPlaceNavigation({
        action: "REPLACE",
        previousKey: "page:home",
        activeKey: "thread:env/a",
      }),
    ).toBe(false);
    expect(
      isInPlaceNavigation({ action: "PUSH", previousKey: "draft:d1", activeKey: "draft:d1" }),
    ).toBe(false);
  });
});

describe("sanitizePersistedTabs", () => {
  it("drops malformed, duplicate, and mismatched tabs", () => {
    const state = sanitizePersistedTabs({
      activeTabId: "gone",
      tabs: [
        { id: "t0", key: "page:home", href: "/", kept: true, label: null },
        { id: "t0", key: "page:usage", href: "/usage", kept: true, label: null },
        { id: "t1", key: "page:home", href: "/", kept: true, label: null },
        { id: "t2", key: "thread:env/a", href: "/usage", kept: true, label: null },
        { id: "t3", key: "thread:env/a", href: "/env/a", kept: false, label: "A" },
        { id: "t4", key: "thread:env/b", href: "/env/b", kept: false, label: null },
        { id: 5 },
        null,
      ],
    });
    expect(state.tabs.map((tab) => tab.id)).toEqual(["t0", "t3", "t4"]);
    expect(state.tabs.map((tab) => tab.kept)).toEqual([true, false, true]);
    expect(state.activeTabId).toBeNull();
  });

  it("returns no tabs for anything that is not a stored tab state", () => {
    expect(sanitizePersistedTabs(null)).toEqual(EMPTY_WORKSPACE_TABS);
    expect(sanitizePersistedTabs({ tabs: "nope" })).toEqual(EMPTY_WORKSPACE_TABS);
  });
});
