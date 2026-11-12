import type { ScopedThreadRef } from "@circe/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { tabKeyOf } from "../../workspaceTabs.logic";
import { useWorkspaceTabsStore } from "../../workspaceTabsStore";

/** Opens a thread in a kept tab beside the current one, without leaving it. */
export function useOpenThreadInBackgroundTab(): (threadRef: ScopedThreadRef) => void {
  const router = useRouter();
  const openInBackground = useWorkspaceTabsStore((store) => store.openInBackground);
  return useCallback(
    (threadRef) => {
      openInBackground({
        key: tabKeyOf({
          kind: "thread",
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
        }),
        href: router.buildLocation({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }).href,
      });
    },
    [openInBackground, router],
  );
}
