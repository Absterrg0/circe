import type { EnvironmentId } from "@circe/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  LayersIcon,
  ListTodoIcon,
  MicIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { shortcutLabelForCommand } from "../../keybindings";
import { useThreadShells } from "../../state/entities";
import {
  useEnvironmentConnectionSummaries,
  useEnvironmentMachines,
  usePullRequestsSupported,
} from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { environmentMachineIcon } from "../EnvironmentMachineIcon";
import { CIRCE_RAIL_MARK_SRC } from "./CirceBrand";
import {
  getCirceLiveVoiceUiState,
  subscribeCirceLiveVoice,
  toggleCirceLiveVoiceFromUser,
} from "./CirceLiveVoice.bridge";
import { Presence, type CircePresenceState } from "./ui/StatusGlyph";

import "./circe-shell.css";

type RailDestination = "overview" | "tasks" | "pulls" | "scheduled" | "usage" | "settings";

function resolveRailDestination(pathname: string): RailDestination {
  if (pathname === "/circe") return "overview";
  if (pathname === "/pull-requests") return "pulls";
  if (pathname === "/usage") return "usage";
  if (pathname.startsWith("/settings/scheduled-tasks")) return "scheduled";
  if (/^\/settings(\/|$)/.test(pathname)) return "settings";
  return "tasks";
}

/** Lowercase two-character tile label from a node name: "forge" -> "fo". */
export function railNodeMonogram(label: string): string {
  const letters = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  return letters.slice(0, 2) || "?";
}

function RailTip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children as React.ReactElement} />
      <TooltipPopup side="right">{label}</TooltipPopup>
    </Tooltip>
  );
}

function useNeedsYouCount(): number {
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

function useLiveVoiceListening(): boolean {
  const [state, setState] = useState(getCirceLiveVoiceUiState);
  useEffect(() => subscribeCirceLiveVoice(() => setState(getCirceLiveVoiceUiState())), []);
  return state.active;
}

/**
 * The desktop rail: the mark opens the overview, destinations switch what the
 * inset sidebar and canvas show, and one tile per machine scopes the task
 * list. It is Void in both themes so the mark always sits on black.
 */
export const CirceRail = memo(function CirceRail({
  macos,
  electron,
}: {
  readonly macos: boolean;
  readonly electron: boolean;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const destination = resolveRailDestination(pathname);
  const { open, setOpen } = useSidebar();
  const needs = useNeedsYouCount();
  const listening = useLiveVoiceListening();
  const pullRequestsSupported = usePullRequestsSupported();
  const environments = useEnvironmentConnectionSummaries();
  const machineById = useEnvironmentMachines();
  const scope = useUiStateStore((store) => store.sidebarMachineScope);
  const setScope = useUiStateStore((store) => store.setSidebarMachineScope);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const paletteShortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const sidebarShortcut = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  // A scope whose machine left the catalog falls back to all machines.
  useEffect(() => {
    if (scope !== null && !environments.some((env) => env.environmentId === scope)) {
      setScope(null);
    }
  }, [environments, scope, setScope]);

  const nodes = useMemo(
    () =>
      environments
        .filter((env) => env.isEnabled)
        .map((env) => {
          const presence: CircePresenceState =
            env.connectionState === "connected"
              ? "online"
              : env.connectionState === "connecting" || env.connectionState === "reconnecting"
                ? "busy"
                : "offline";
          return {
            environmentId: env.environmentId as EnvironmentId,
            label: env.environmentLabel,
            presence,
            machine: machineById.get(env.environmentId) ?? "server",
          };
        }),
    [environments, machineById],
  );

  const showTasks = () => {
    if (destination === "tasks") {
      // Tasks is where the sidebar lives: pressing it again folds the
      // sidebar away, leaving the rail and the canvas.
      setOpen(!open);
      return;
    }
    setOpen(true);
    void navigate({ to: "/" });
  };

  const scopeTo = (environmentId: EnvironmentId | null) => {
    setScope(environmentId);
    setOpen(true);
    if (destination !== "tasks") void navigate({ to: "/" });
  };

  return (
    <nav
      className="ci-rail"
      aria-label="Circe"
      data-macos={macos ? "true" : "false"}
      data-drag={electron ? "true" : "false"}
    >
      <RailTip label="Overview">
        <button
          type="button"
          className="ci-rail__mark"
          aria-label="Overview"
          data-active={destination === "overview" ? "true" : "false"}
          onClick={() => void navigate({ to: "/circe" })}
        >
          <img alt="" src={CIRCE_RAIL_MARK_SRC} />
        </button>
      </RailTip>
      <div className="ci-rail__group">
        <RailTip
          label={
            needs > 0
              ? `Tasks · ${needs} need${needs === 1 ? "s" : ""} you`
              : `Tasks${sidebarShortcut && destination === "tasks" ? `  ${sidebarShortcut}` : ""}`
          }
        >
          <button
            type="button"
            className="ci-rail__btn"
            aria-label={needs > 0 ? `Tasks, ${needs} need you` : "Tasks"}
            data-active={destination === "tasks" ? "true" : "false"}
            onClick={showTasks}
          >
            <ListTodoIcon />
            {needs > 0 ? (
              <span className="ci-rail__badge">{needs > 99 ? "99+" : needs}</span>
            ) : null}
          </button>
        </RailTip>
        {pullRequestsSupported ? (
          <RailTip label="Pull requests">
            <button
              type="button"
              className="ci-rail__btn"
              aria-label="Pull requests"
              data-active={destination === "pulls" ? "true" : "false"}
              onClick={() =>
                void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
              }
            >
              <PullRequestGlyph.pullRequest />
            </button>
          </RailTip>
        ) : null}
        <RailTip label="Scheduled">
          <button
            type="button"
            className="ci-rail__btn"
            aria-label="Scheduled"
            data-active={destination === "scheduled" ? "true" : "false"}
            onClick={() => void navigate({ to: "/settings/scheduled-tasks" })}
          >
            <CalendarClockIcon />
          </button>
        </RailTip>
        <RailTip label="Usage">
          <button
            type="button"
            className="ci-rail__btn"
            aria-label="Usage"
            data-active={destination === "usage" ? "true" : "false"}
            onClick={() => void navigate({ to: "/usage" })}
          >
            <ChartNoAxesColumnIcon />
          </button>
        </RailTip>
      </div>
      <div className="ci-rail__rule" />
      <div className="ci-rail__group ci-rail__nodes" aria-label="Machines">
        {nodes.length > 1 ? (
          <RailTip label="All machines">
            <button
              type="button"
              className="ci-rail__node ci-rail__node--all"
              aria-label="All machines"
              aria-pressed={scope === null}
              data-scoped={scope === null ? "true" : "false"}
              onClick={() => scopeTo(null)}
            >
              <LayersIcon />
            </button>
          </RailTip>
        ) : null}
        {nodes.map((node) => {
          const MachineIcon = environmentMachineIcon(node.machine);
          const scoped = scope === node.environmentId;
          return (
            <RailTip
              key={node.environmentId}
              label={`${node.label} · ${node.presence === "online" ? "online" : node.presence === "busy" ? "connecting…" : "offline"}`}
            >
              <button
                type="button"
                className="ci-rail__node"
                aria-label={`${node.label}, ${node.presence}`}
                aria-pressed={scoped}
                data-scoped={scoped ? "true" : "false"}
                data-offline={node.presence === "offline" ? "true" : "false"}
                onClick={() => scopeTo(scoped || nodes.length === 1 ? null : node.environmentId)}
              >
                {nodes.length > 1 ? railNodeMonogram(node.label) : <MachineIcon />}
                <Presence state={node.presence} ring="var(--rail)" />
              </button>
            </RailTip>
          );
        })}
        <RailTip label="Pair a machine">
          <button
            type="button"
            className="ci-rail__node ci-rail__node--add"
            aria-label="Pair a machine"
            onClick={() => void navigate({ to: "/settings/connections" })}
          >
            <PlusIcon />
          </button>
        </RailTip>
      </div>
      <div className="ci-rail__spacer" />
      <div className="ci-rail__group">
        <RailTip label={`Search${paletteShortcut ? `  ${paletteShortcut}` : ""}`}>
          <button
            type="button"
            className="ci-rail__btn"
            aria-label="Search"
            onClick={() => openCommandPalette()}
          >
            <SearchIcon />
          </button>
        </RailTip>
        <RailTip label={listening ? "End conversation" : "Talk to Circe"}>
          <button
            type="button"
            className="ci-rail__btn ci-rail__mic"
            aria-label={listening ? "End conversation with Circe" : "Talk to Circe"}
            aria-pressed={listening}
            data-listening={listening ? "true" : "false"}
            onClick={toggleCirceLiveVoiceFromUser}
          >
            <MicIcon />
          </button>
        </RailTip>
        <RailTip label="Settings">
          <button
            type="button"
            className="ci-rail__btn"
            aria-label="Settings"
            data-active={destination === "settings" ? "true" : "false"}
            onClick={() => void navigate({ to: "/settings" })}
          >
            <SettingsIcon />
          </button>
        </RailTip>
      </div>
    </nav>
  );
});
