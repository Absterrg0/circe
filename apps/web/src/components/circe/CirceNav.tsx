import type { EnvironmentId } from "@circe/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  ListTodoIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ComponentType } from "react";

import { useThreadShells } from "../../state/entities";
import {
  useEnvironmentConnectionSummaries,
  useEnvironmentMachines,
  usePrimaryEnvironmentId,
  usePullRequestsSupported,
} from "../../state/environments";
import { environmentMachineIcon } from "../EnvironmentMachineIcon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { getCirceLiveVoiceUiState, subscribeCirceLiveVoice } from "./CirceLiveVoice.bridge";
import type { CircePresenceState } from "./ui/StatusGlyph";

/**
 * Where the rail points. Each destination either owns a panel (the inset
 * sidebar lists what is inside it) or is a full-width page.
 */
export type CirceDestination = "home" | "tasks" | "pulls" | "scheduled" | "usage" | "settings";

export function resolveCirceDestination(pathname: string): CirceDestination {
  if (pathname === "/circe") return "home";
  if (pathname === "/pull-requests") return "pulls";
  if (pathname === "/scheduled") return "scheduled";
  if (pathname === "/usage") return "usage";
  if (/^\/settings(\/|$)/.test(pathname)) return "settings";
  return "tasks";
}

/** Home and Usage are dashboards and use the whole canvas. */
export function destinationHasPanel(destination: CirceDestination): boolean {
  return destination !== "home" && destination !== "usage";
}

export interface CirceNavItem {
  readonly id: Exclude<CirceDestination, "home" | "settings">;
  readonly label: string;
  readonly icon: LucideIcon | ComponentType<{ className?: string }>;
}

export function useCirceNavItems(): ReadonlyArray<CirceNavItem> {
  const pullRequestsSupported = usePullRequestsSupported();
  return useMemo(
    () => [
      { id: "tasks", label: "Tasks", icon: ListTodoIcon },
      ...(pullRequestsSupported
        ? [{ id: "pulls" as const, label: "Pull requests", icon: PullRequestGlyph.pullRequest }]
        : []),
      { id: "scheduled", label: "Scheduled", icon: CalendarClockIcon },
      { id: "usage", label: "Usage", icon: ChartNoAxesColumnIcon },
    ],
    [pullRequestsSupported],
  );
}

// The last task route the user had open, so Tasks returns to it instead of
// landing on the index route, which starts a new draft.
let lastTaskHref: string | null = null;

export function rememberTaskHref(href: string) {
  lastTaskHref = href;
}

export function useCirceNavigate() {
  const navigate = useNavigate();
  const threads = useThreadShells();
  return (id: CirceNavItem["id"] | "home") => {
    switch (id) {
      case "home":
        return void navigate({ to: "/circe" });
      case "tasks": {
        if (lastTaskHref !== null) return void navigate({ href: lastTaskHref });
        // Nothing opened yet this session: the most recent task, never a new
        // draft. The index route only runs when there is no task at all.
        let latest: (typeof threads)[number] | null = null;
        for (const thread of threads) {
          if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
          if (latest === null || thread.updatedAt > latest.updatedAt) latest = thread;
        }
        return latest === null
          ? void navigate({ to: "/" })
          : void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: latest.environmentId, threadId: latest.id },
            });
      }
      case "pulls":
        return void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
      case "scheduled":
        return void navigate({ to: "/scheduled" });
      case "usage":
        return void navigate({ to: "/usage" });
    }
  };
}

/** Tasks waiting on an approval or an answer, across every machine. */
export function useNeedsYouCount(): number {
  const threads = useThreadShells();
  return useMemo(() => {
    let count = 0;
    for (const thread of threads) {
      const status = resolveSidebarThreadStatus(thread);
      if (status === "approval" || status === "input") count += 1;
    }
    return count;
  }, [threads]);
}

export function useLiveVoiceListening(): boolean {
  const [state, setState] = useState(getCirceLiveVoiceUiState);
  useEffect(() => subscribeCirceLiveVoice(() => setState(getCirceLiveVoiceUiState())), []);
  return state.active;
}

export interface CirceMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly presence: CircePresenceState;
  readonly icon: ComponentType<{ className?: string }>;
  readonly current: boolean;
}

export const PRESENCE_WORD: Readonly<Record<CircePresenceState, string>> = {
  online: "online",
  busy: "connecting…",
  offline: "offline",
};

/** Enabled machines with their presence, the current one first. */
export function useCirceMachines(): ReadonlyArray<CirceMachine> {
  const environments = useEnvironmentConnectionSummaries();
  const machineById = useEnvironmentMachines();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useMemo(
    () =>
      environments
        .filter((env) => env.isEnabled)
        .map((env): CirceMachine => ({
          environmentId: env.environmentId as EnvironmentId,
          label: env.environmentLabel.toLowerCase(),
          presence:
            env.connectionState === "connected"
              ? "online"
              : env.connectionState === "connecting" || env.connectionState === "reconnecting"
                ? "busy"
                : "offline",
          icon: environmentMachineIcon(machineById.get(env.environmentId) ?? "server"),
          current: env.environmentId === primaryEnvironmentId,
        }))
        .toSorted((left, right) => Number(right.current) - Number(left.current)),
    [environments, machineById, primaryEnvironmentId],
  );
}
