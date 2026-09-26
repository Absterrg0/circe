import { scopeThreadRef } from "@circe/client/environment";
import {
  circeBotIdOfPlace,
  circeBotPlaceId,
  ProjectId,
  ThreadId,
  type CirceHostFocus,
  type EnvironmentId,
} from "@circe/contracts";
import { useRouterState } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { type CirceCommandTarget, onOpenCirce } from "../../circeBus";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import type { AppRouter } from "../../router";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import {
  isCirceShortcut,
  isCirceLocalVoiceRoute,
  resolveCirceDesktopMenuAction,
  shouldHandleCirceShortcutInRenderer,
} from "./CirceManager.logic";
import { CirceDesktopOrbReporter } from "./CirceDesktopOrbReporter";
import { CirceHostNoticeReporter } from "./CirceHostNoticeReporter";
import { CirceLiveVoiceRuntime } from "./CirceLiveVoiceRuntime";
import { CirceVoiceCapture } from "./CirceVoiceCapture";
import { getCirceLiveVoiceUiState, setCirceLiveVoiceActive } from "./CirceLiveVoice.bridge";
import { CirceVoiceReporter } from "./CirceVoiceReporter";

const CirceVoiceRuntime = lazy(async () => {
  const module = await import("./CirceVoiceRuntime");
  return { default: module.CirceVoiceRuntime };
});

export function CirceManagerHost({ router }: { readonly router: AppRouter }) {
  const routeTarget = useRouterState({
    router,
    select: (state) =>
      resolveThreadRouteTarget(state.matches[state.matches.length - 1]?.params ?? {}),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  // A bot page is a place in the host layer's world, not a thread route.
  const routeBot = useRouterState({
    router,
    select: (state) => {
      const params = state.matches[state.matches.length - 1]?.params as
        | { readonly environmentId?: string; readonly botId?: string }
        | undefined;
      return params?.botId === undefined || params.environmentId === undefined
        ? null
        : `${params.environmentId}\u0000${params.botId}`;
    },
  });
  const activeThread = useThreadShell(routeThreadRef);
  const activeDraftThread = useComposerDraftStore((store) => {
    if (!routeTarget) return null;
    return routeTarget.kind === "server"
      ? store.getDraftThread(routeTarget.threadRef)
      : store.getDraftSession(routeTarget.draftId);
  });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const circeSurfaceOpen = useRouterState({
    router,
    select: (state) => {
      const pathname =
        (state as unknown as { location?: { pathname?: string } }).location?.pathname ?? "";
      return pathname === "/circe" || pathname.startsWith("/circe/");
    },
  });
  // Once the browser Circe surface opens, its runtime stays mounted until
  // the host unmounts so an explicit target survives navigation and remounts.
  const [browserRuntimeLatched, setBrowserRuntimeLatched] = useState(false);
  useEffect(() => {
    if (circeSurfaceOpen) setBrowserRuntimeLatched(true);
  }, [circeSurfaceOpen]);

  // One-time cleanup: reports used to persist an attention target that stole
  // command focus after reload. That path is gone; drop the stale key.
  useEffect(() => {
    try {
      localStorage.removeItem("circe:circe:attention-target:v1");
    } catch {
      // Blocked storage must not break the control center.
    }
  }, []);

  useEffect(() => {
    if (!shouldHandleCirceShortcutInRenderer(isElectron)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isCirceShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      void router.navigate({ to: "/circe" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  useEffect(
    () =>
      onOpenCirce(() => {
        void router.navigate({ to: "/circe" });
      }),
    [router],
  );

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    const removeMenuActionListener = onMenuAction((action) => {
      const resolvedAction = resolveCirceDesktopMenuAction(action);
      switch (resolvedAction) {
        case "open-control-center":
          void router.navigate({ to: "/circe" });
          break;
        case "live-voice-toggle":
          setCirceLiveVoiceActive(!getCirceLiveVoiceUiState().active);
          break;
        case null:
          break;
      }
    });
    return () => {
      removeMenuActionListener();
    };
  }, [router]);

  const routeCommandTarget: CirceCommandTarget | null =
    activeThread !== null &&
    isCirceLocalVoiceRoute(primaryEnvironmentId, activeThread.environmentId)
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeThread.projectId,
          contextThreadId: activeThread.id,
          contextThreadTitle: activeThread.title,
        }
      : activeDraftThread !== null &&
          isCirceLocalVoiceRoute(primaryEnvironmentId, activeDraftThread.environmentId)
        ? {
            environmentId: activeDraftThread.environmentId,
            projectId: activeDraftThread.projectId,
          }
        : null;
  const [botEnvironmentId, botId] = routeBot === null ? [null, null] : routeBot.split("\u0000");
  // What the host layer is told is on screen. Bot pages count only on this
  // node, like threads, because the host layer reads this node's world.
  const hostFocus: CirceHostFocus | undefined =
    botId !== null &&
    botId !== undefined &&
    isCirceLocalVoiceRoute(primaryEnvironmentId, botEnvironmentId as EnvironmentId)
      ? {
          projectId: ProjectId.make(circeBotPlaceId(botId)),
          threadId: ThreadId.make(circeBotPlaceId(botId)),
        }
      : routeCommandTarget === null
        ? undefined
        : {
            projectId: routeCommandTarget.projectId,
            ...(routeCommandTarget.contextThreadId === undefined
              ? {}
              : { threadId: routeCommandTarget.contextThreadId }),
          };
  const handleThreadStarted = useCallback(
    async (environmentId: EnvironmentId, threadId: ThreadId) => {
      const startedBot = circeBotIdOfPlace(threadId);
      if (startedBot !== null) {
        await router.navigate({
          to: "/bots/$environmentId/$botId",
          params: { environmentId, botId: startedBot },
        });
        return;
      }
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    },
    [router],
  );
  // Native voice stays mounted on desktop. Browser mounts lazily when the
  // Circe surface first opens, then stays latched for the host lifetime.
  const shouldMountRuntime = isElectron || circeSurfaceOpen || browserRuntimeLatched;

  return (
    <>
      <CirceVoiceReporter />
      <CirceLiveVoiceRuntime />
      {isElectron && primaryEnvironmentId !== null ? (
        <CirceVoiceCapture
          environmentId={primaryEnvironmentId}
          routeTarget={routeCommandTarget}
          hostFocus={hostFocus}
          onThreadStarted={handleThreadStarted}
        />
      ) : null}
      {primaryEnvironmentId !== null ? (
        <CirceHostNoticeReporter environmentId={primaryEnvironmentId} />
      ) : null}
      {isElectron && primaryEnvironmentId !== null ? (
        <CirceDesktopOrbReporter environmentId={primaryEnvironmentId} />
      ) : null}
      {shouldMountRuntime ? (
        <Suspense fallback={null}>
          <CirceVoiceRuntime
            routeTarget={routeCommandTarget}
            hostFocus={hostFocus}
            onTargetConsumed={() => undefined}
            onThreadStarted={handleThreadStarted}
          />
        </Suspense>
      ) : null}
    </>
  );
}
