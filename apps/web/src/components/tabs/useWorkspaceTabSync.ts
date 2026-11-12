import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { isInPlaceNavigation, resolveTabKey } from "../../workspaceTabs.logic";
import { useWorkspaceTabsStore } from "../../workspaceTabsStore";

/**
 * Keeps the tab strip in step with the router. Every navigation, wherever it
 * starts (a sidebar row, the command palette, a redirect, the back button),
 * lands in the tab that owns the new location, so nothing else in the app has
 * to know tabs exist.
 */
export function useWorkspaceTabSync(): void {
  const router = useRouter();
  useEffect(() => {
    let previousKey: string | null = null;
    const apply = (action: "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO") => {
      const { pathname, href } = router.history.location;
      const key = resolveTabKey(pathname);
      if (key !== null) {
        const { tabs, activeTabId, syncLocation } = useWorkspaceTabsStore.getState();
        const activeKey = tabs.find((tab) => tab.id === activeTabId)?.key ?? null;
        syncLocation({ key, href }, isInPlaceNavigation({ action, previousKey, activeKey }));
      }
      previousKey = key;
    };
    apply("PUSH");
    return router.history.subscribe(({ action }) => apply(action.type));
  }, [router]);
}
