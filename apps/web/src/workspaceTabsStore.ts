import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";
import {
  addBackgroundTab,
  closeOtherTabs,
  closeTab,
  closeTabsByKey,
  closeTabsToRight,
  EMPTY_WORKSPACE_TABS,
  keepTab,
  moveTab,
  openTabLocation,
  replaceActiveTabLocation,
  sanitizePersistedTabs,
  setTabLabel,
  type TabCloseResult,
  type TabLocation,
  type WorkspaceTabsState,
} from "./workspaceTabs.logic";

const WORKSPACE_TABS_STORAGE_KEY = "circe:workspace-tabs:v1";

interface WorkspaceTabsStore extends WorkspaceTabsState {
  /** A navigation reached `location`; `inPlace` when it continues the active tab. */
  readonly syncLocation: (location: TabLocation, inPlace: boolean) => void;
  readonly openInBackground: (location: TabLocation) => void;
  readonly keep: (tabId: string) => void;
  readonly keepActive: () => void;
  readonly setLabel: (tabId: string, label: string) => void;
  readonly move: (tabId: string, overTabId: string) => void;
  /** Each close returns where to navigate when the tab on screen closed. */
  readonly close: (tabId: string) => string | null;
  readonly closeOthers: (tabId: string) => string | null;
  readonly closeToRight: (tabId: string) => string | null;
  readonly closeByKey: (keys: ReadonlySet<string>) => string | null;
}

export const useWorkspaceTabsStore = create<WorkspaceTabsStore>()(
  persist(
    (set, get) => {
      const applyClose = (result: TabCloseResult): string | null => {
        set(result.state);
        return result.navigateTo;
      };
      return {
        ...EMPTY_WORKSPACE_TABS,
        syncLocation: (location, inPlace) =>
          set((state) =>
            inPlace
              ? replaceActiveTabLocation(state, location, randomUUID())
              : openTabLocation(state, location, randomUUID()),
          ),
        openInBackground: (location) =>
          set((state) => addBackgroundTab(state, location, randomUUID())),
        keep: (tabId) => set((state) => keepTab(state, tabId)),
        keepActive: () =>
          set((state) => (state.activeTabId === null ? state : keepTab(state, state.activeTabId))),
        setLabel: (tabId, label) => set((state) => setTabLabel(state, tabId, label)),
        move: (tabId, overTabId) => set((state) => moveTab(state, tabId, overTabId)),
        close: (tabId) => applyClose(closeTab(get(), tabId)),
        closeOthers: (tabId) => applyClose(closeOtherTabs(get(), tabId)),
        closeToRight: (tabId) => applyClose(closeTabsToRight(get(), tabId)),
        closeByKey: (keys) => applyClose(closeTabsByKey(get(), keys)),
      };
    },
    {
      name: WORKSPACE_TABS_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ tabs: state.tabs, activeTabId: state.activeTabId }),
      merge: (persisted, current) => ({ ...current, ...sanitizePersistedTabs(persisted) }),
    },
  ),
);
