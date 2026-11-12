import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

export type SidebarSectionId = "chats" | "bots";

interface SidebarSectionsStore {
  /** Sections the user folded shut. */
  readonly collapsed: Readonly<Partial<Record<SidebarSectionId, boolean>>>;
  readonly toggle: (section: SidebarSectionId) => void;
}

/** Which sidebar lists are folded, remembered on this device. */
export const useSidebarSectionsStore = create<SidebarSectionsStore>()(
  persist(
    (set) => ({
      collapsed: {},
      toggle: (section) =>
        set((state) => ({
          collapsed: { ...state.collapsed, [section]: state.collapsed[section] !== true },
        })),
    }),
    {
      name: "circe:sidebar-sections:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ collapsed: state.collapsed }),
    },
  ),
);
