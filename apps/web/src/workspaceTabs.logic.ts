/**
 * The tab strip's model. A tab is one place in the workspace (a thread, a
 * draft, a bot, or a page) and remembers the last location shown there. The
 * router stays the owner of what is on screen: these functions only decide
 * which tab a location belongs to.
 *
 * Opening follows editor tabs. A place that is already open is focused. A new
 * place lands in the one preview tab, replacing whatever was previewed there,
 * so browsing a list does not pile up tabs. Keeping a tab (double-click,
 * typing in it, dragging it, opening it in the background) makes it stay.
 */

export type WorkspacePage = "home" | "pull-requests" | "machines" | "usage" | "settings";

export type WorkspaceTabTarget =
  | { readonly kind: "page"; readonly page: WorkspacePage }
  | { readonly kind: "thread"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "draft"; readonly draftId: string }
  | { readonly kind: "bot"; readonly environmentId: string; readonly botId: string };

export interface WorkspaceTab {
  readonly id: string;
  /** What the tab shows; two tabs never share a key. */
  readonly key: string;
  /** Path, search, and hash to return to. */
  readonly href: string;
  /** False while the tab is the preview tab. */
  readonly kept: boolean;
  /** Last title shown, so a restored tab has a name before its data loads. */
  readonly label: string | null;
}

export interface WorkspaceTabsState {
  readonly tabs: ReadonlyArray<WorkspaceTab>;
  readonly activeTabId: string | null;
}

export const EMPTY_WORKSPACE_TABS: WorkspaceTabsState = { tabs: [], activeTabId: null };

const HOME_TAB_HREF = "/";

const THREAD_ROUTE = /^\/([^/]+)\/([^/]+)\/?$/;
const DRAFT_ROUTE = /^\/draft\/([^/]+)\/?$/;
const BOT_ROUTE = /^\/bots\/([^/]+)\/([^/]+)\/?$/;

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The place a pathname shows, or null for routes outside the workspace shell
 * (pairing, onboarding). Every Settings page is one place, so moving between
 * sections stays in one tab.
 */
export function resolveTabTarget(pathname: string): WorkspaceTabTarget | null {
  if (pathname === "/" || pathname === "/circe") return { kind: "page", page: "home" };
  if (pathname === "/pull-requests") return { kind: "page", page: "pull-requests" };
  if (pathname === "/machines") return { kind: "page", page: "machines" };
  if (pathname === "/usage") return { kind: "page", page: "usage" };
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return { kind: "page", page: "settings" };
  }
  // Project links redirect into Settings.
  if (pathname.startsWith("/projects/")) return { kind: "page", page: "settings" };
  if (pathname === "/pair" || pathname === "/connect" || pathname === "/welcome") return null;
  if (pathname === "/circe-preview") return null;

  const draft = DRAFT_ROUTE.exec(pathname);
  if (draft) return { kind: "draft", draftId: decode(draft[1]!) };
  const bot = BOT_ROUTE.exec(pathname);
  if (bot) return { kind: "bot", environmentId: decode(bot[1]!), botId: decode(bot[2]!) };
  const thread = THREAD_ROUTE.exec(pathname);
  if (thread) {
    return { kind: "thread", environmentId: decode(thread[1]!), threadId: decode(thread[2]!) };
  }
  return null;
}

export function tabKeyOf(target: WorkspaceTabTarget): string {
  switch (target.kind) {
    case "page":
      return `page:${target.page}`;
    case "thread":
      return `thread:${target.environmentId}/${target.threadId}`;
    case "draft":
      return `draft:${target.draftId}`;
    case "bot":
      return `bot:${target.environmentId}/${target.botId}`;
  }
}

export function resolveTabKey(pathname: string): string | null {
  const target = resolveTabTarget(pathname);
  return target === null ? null : tabKeyOf(target);
}

/** The pathname part of an href, which is all a tab's target depends on. */
export function tabTargetOfHref(href: string): WorkspaceTabTarget | null {
  const end = href.search(/[?#]/);
  return resolveTabTarget(end === -1 ? href : href.slice(0, end));
}

export interface TabLocation {
  readonly key: string;
  readonly href: string;
}

function replaceAt(
  tabs: ReadonlyArray<WorkspaceTab>,
  index: number,
  tab: WorkspaceTab,
): ReadonlyArray<WorkspaceTab> {
  return tabs.map((current, position) => (position === index ? tab : current));
}

/**
 * A navigation to `location`: focus its tab if it is open, otherwise show it
 * in the preview tab, otherwise open a preview tab beside the active one.
 */
export function openTabLocation(
  state: WorkspaceTabsState,
  location: TabLocation,
  newTabId: string,
): WorkspaceTabsState {
  const existingIndex = state.tabs.findIndex((tab) => tab.key === location.key);
  if (existingIndex !== -1) {
    const existing = state.tabs[existingIndex]!;
    if (existing.href === location.href && state.activeTabId === existing.id) return state;
    return {
      tabs:
        existing.href === location.href
          ? state.tabs
          : replaceAt(state.tabs, existingIndex, { ...existing, href: location.href }),
      activeTabId: existing.id,
    };
  }

  const previewIndex = state.tabs.findIndex((tab) => !tab.kept);
  if (previewIndex !== -1) {
    const preview = state.tabs[previewIndex]!;
    return {
      tabs: replaceAt(state.tabs, previewIndex, { ...preview, ...location, label: null }),
      activeTabId: preview.id,
    };
  }

  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const insertAt = activeIndex === -1 ? state.tabs.length : activeIndex + 1;
  const tab: WorkspaceTab = { id: newTabId, ...location, kept: false, label: null };
  return {
    tabs: [...state.tabs.slice(0, insertAt), tab, ...state.tabs.slice(insertAt)],
    activeTabId: tab.id,
  };
}

/**
 * The active tab's place changed where it stands: a draft became a thread, or
 * a deleted thread sent its tab Home. The tab keeps its position and whether
 * it was kept. When the new place is already open elsewhere, the active tab
 * closes into that one instead of duplicating it.
 */
export function replaceActiveTabLocation(
  state: WorkspaceTabsState,
  location: TabLocation,
  newTabId: string,
): WorkspaceTabsState {
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  if (activeIndex === -1) return openTabLocation(state, location, newTabId);
  const active = state.tabs[activeIndex]!;
  if (active.key === location.key) {
    return active.href === location.href
      ? state
      : { ...state, tabs: replaceAt(state.tabs, activeIndex, { ...active, href: location.href }) };
  }
  const existing = state.tabs.find((tab) => tab.key === location.key);
  if (existing) {
    return {
      tabs: state.tabs
        .filter((tab) => tab.id !== active.id)
        .map((tab) => (tab.id === existing.id ? { ...tab, href: location.href } : tab)),
      activeTabId: existing.id,
    };
  }
  return {
    ...state,
    tabs: replaceAt(state.tabs, activeIndex, { ...active, ...location, label: null }),
  };
}

/** Open a place without leaving the current tab. Background tabs are kept. */
export function addBackgroundTab(
  state: WorkspaceTabsState,
  location: TabLocation,
  newTabId: string,
): WorkspaceTabsState {
  const existingIndex = state.tabs.findIndex((tab) => tab.key === location.key);
  if (existingIndex !== -1) {
    const existing = state.tabs[existingIndex]!;
    return existing.kept
      ? state
      : { ...state, tabs: replaceAt(state.tabs, existingIndex, { ...existing, kept: true }) };
  }
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const insertAt = activeIndex === -1 ? state.tabs.length : activeIndex + 1;
  const tab: WorkspaceTab = { id: newTabId, ...location, kept: true, label: null };
  return {
    ...state,
    tabs: [...state.tabs.slice(0, insertAt), tab, ...state.tabs.slice(insertAt)],
  };
}

export function keepTab(state: WorkspaceTabsState, tabId: string): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || state.tabs[index]!.kept) return state;
  return { ...state, tabs: replaceAt(state.tabs, index, { ...state.tabs[index]!, kept: true }) };
}

export function setTabLabel(
  state: WorkspaceTabsState,
  tabId: string,
  label: string,
): WorkspaceTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || state.tabs[index]!.label === label) return state;
  return { ...state, tabs: replaceAt(state.tabs, index, { ...state.tabs[index]!, label }) };
}

export interface TabCloseResult {
  readonly state: WorkspaceTabsState;
  /** Where to go when the tab on screen closed; null when it was not active. */
  readonly navigateTo: string | null;
}

/**
 * Close tabs. When the active tab is among them, the nearest surviving tab to
 * its right takes over, then the nearest to its left, then Home.
 */
function closeTabs(state: WorkspaceTabsState, tabIds: ReadonlySet<string>): TabCloseResult {
  const remaining = state.tabs.filter((tab) => !tabIds.has(tab.id));
  if (remaining.length === state.tabs.length) return { state, navigateTo: null };
  if (state.activeTabId === null || !tabIds.has(state.activeTabId)) {
    return { state: { ...state, tabs: remaining }, navigateTo: null };
  }
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const successor =
    state.tabs.slice(activeIndex + 1).find((tab) => !tabIds.has(tab.id)) ??
    state.tabs
      .slice(0, activeIndex)
      .toReversed()
      .find((tab) => !tabIds.has(tab.id)) ??
    null;
  return {
    state: { tabs: remaining, activeTabId: successor?.id ?? null },
    navigateTo: successor?.href ?? HOME_TAB_HREF,
  };
}

export function closeTab(state: WorkspaceTabsState, tabId: string): TabCloseResult {
  return closeTabs(state, new Set([tabId]));
}

export function closeOtherTabs(state: WorkspaceTabsState, tabId: string): TabCloseResult {
  return closeTabs(
    state,
    new Set(state.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id)),
  );
}

export function closeTabsToRight(state: WorkspaceTabsState, tabId: string): TabCloseResult {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return { state, navigateTo: null };
  return closeTabs(state, new Set(state.tabs.slice(index + 1).map((tab) => tab.id)));
}

/** Close whichever tabs show these places, such as a deleted thread. */
export function closeTabsByKey(
  state: WorkspaceTabsState,
  keys: ReadonlySet<string>,
): TabCloseResult {
  return closeTabs(
    state,
    new Set(state.tabs.filter((tab) => keys.has(tab.key)).map((tab) => tab.id)),
  );
}

/** Drop a tab at another tab's position. Arranging a tab keeps it. */
export function moveTab(
  state: WorkspaceTabsState,
  tabId: string,
  overTabId: string,
): WorkspaceTabsState {
  const from = state.tabs.findIndex((tab) => tab.id === tabId);
  const to = state.tabs.findIndex((tab) => tab.id === overTabId);
  if (from === -1 || to === -1 || from === to) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, { ...moved!, kept: true });
  return { ...state, tabs };
}

/** The tab `offset` steps from the active one, wrapping at either end. */
export function tabAtOffset(state: WorkspaceTabsState, offset: number): WorkspaceTab | null {
  if (state.tabs.length === 0) return null;
  const activeIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
  const start = activeIndex === -1 ? 0 : activeIndex;
  const length = state.tabs.length;
  return state.tabs[(((start + offset) % length) + length) % length] ?? null;
}

/**
 * Whether a history change continues what the active tab was showing. Only a
 * replace from the active tab's own place counts; a replace arriving from
 * pairing or a redirect opens like any other navigation.
 */
export function isInPlaceNavigation(input: {
  readonly action: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";
  readonly previousKey: string | null;
  readonly activeKey: string | null;
}): boolean {
  return (
    input.action === "REPLACE" &&
    input.previousKey !== null &&
    input.previousKey === input.activeKey
  );
}

function isPersistedTab(value: unknown): value is WorkspaceTab {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.id === "string" &&
    typeof tab.key === "string" &&
    typeof tab.href === "string" &&
    typeof tab.kept === "boolean" &&
    (tab.label === null || typeof tab.label === "string")
  );
}

/**
 * Read stored tabs defensively: drop malformed and duplicate entries, and
 * tabs whose stored key no longer matches where their href leads.
 */
export function sanitizePersistedTabs(value: unknown): WorkspaceTabsState {
  if (typeof value !== "object" || value === null) return EMPTY_WORKSPACE_TABS;
  const candidate = value as { tabs?: unknown; activeTabId?: unknown };
  if (!Array.isArray(candidate.tabs)) return EMPTY_WORKSPACE_TABS;
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  const tabs: WorkspaceTab[] = [];
  let hasPreview = false;
  for (const entry of candidate.tabs) {
    if (!isPersistedTab(entry)) continue;
    const target = tabTargetOfHref(entry.href);
    if (target === null || tabKeyOf(target) !== entry.key) continue;
    if (seenIds.has(entry.id) || seenKeys.has(entry.key)) continue;
    seenIds.add(entry.id);
    seenKeys.add(entry.key);
    // At most one preview tab; extras from an older shape are kept.
    const kept: boolean = entry.kept || hasPreview;
    hasPreview ||= !kept;
    tabs.push({ id: entry.id, key: entry.key, href: entry.href, kept, label: entry.label });
  }
  const activeTabId =
    typeof candidate.activeTabId === "string" && seenIds.has(candidate.activeTabId)
      ? candidate.activeTabId
      : null;
  return { tabs, activeTabId };
}
