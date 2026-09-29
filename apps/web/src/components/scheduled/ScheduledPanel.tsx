import type { EnvironmentId, ScheduledTaskId } from "@circe/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListOrderedIcon, PlusIcon } from "lucide-react";
import { useMemo } from "react";

import { isElectron } from "../../env";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarContent } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { relativeLabel, useScheduledTasks } from "./scheduleLabels";

function PanelMachineSchedules({
  environmentId,
  label,
  showHeading,
  selectedTaskId,
  selectedEnvironmentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showHeading: boolean;
  readonly selectedTaskId: ScheduledTaskId | undefined;
  readonly selectedEnvironmentId: EnvironmentId | null;
}) {
  const navigate = useNavigate();
  const query = useScheduledTasks(environmentId);
  const tasks = useMemo(
    () => (query.data?.tasks ?? []).toSorted((a, b) => a.title.localeCompare(b.title)),
    [query.data],
  );
  const machineSelected = selectedEnvironmentId === environmentId;
  return (
    <div className="ci-panel__group">
      <div className="ci-panel__heading-row">
        {showHeading ? (
          <button
            type="button"
            className="ci-panel__heading ci-panel__heading--link"
            data-active={machineSelected && selectedTaskId === undefined ? "true" : "false"}
            onClick={() => void navigate({ to: "/scheduled", search: { environmentId } })}
          >
            {label}
          </button>
        ) : (
          <button
            type="button"
            className="ci-panel__row"
            data-active={machineSelected && selectedTaskId === undefined ? "true" : "false"}
            onClick={() => void navigate({ to: "/scheduled", search: { environmentId } })}
          >
            <ListOrderedIcon className="ci-panel__icon" />
            <span className="ci-panel__label">Up next</span>
          </button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="ci-panel__add"
                aria-label={`New schedule on ${label}`}
                onClick={() =>
                  void navigate({ to: "/scheduled", search: { environmentId, compose: true } })
                }
              />
            }
          >
            <PlusIcon />
          </TooltipTrigger>
          <TooltipPopup side="right">New schedule on {label}</TooltipPopup>
        </Tooltip>
      </div>
      {query.data === undefined && query.error === null ? (
        <p className="ci-panel__note">Loading…</p>
      ) : query.error ? (
        <p className="ci-panel__note">{query.error}</p>
      ) : tasks.length === 0 ? (
        <p className="ci-panel__note">Nothing scheduled yet.</p>
      ) : (
        tasks.map((task) => {
          const active = machineSelected && selectedTaskId === task.id;
          return (
            <button
              key={task.id}
              type="button"
              className="ci-panel__row ci-panel__row--two"
              data-active={active ? "true" : "false"}
              onClick={() =>
                void navigate({ to: "/scheduled", search: { environmentId, taskId: task.id } })
              }
            >
              <span
                className="ci-panel__dot"
                data-state={
                  !task.enabled
                    ? "paused"
                    : task.lastRunStatus === "failed"
                      ? "failed"
                      : task.lastRunStatus === "running"
                        ? "running"
                        : "on"
                }
                aria-hidden
              />
              <span className="ci-panel__stack">
                <span className="ci-panel__label">{task.title}</span>
                <span className="ci-panel__sub">
                  {task.enabled ? `Next ${relativeLabel(task.nextRunAt)}` : "Paused"}
                </span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

/**
 * The Scheduled page's own sidebar: every machine's schedules, grouped by
 * the machine that runs them.
 */
export function ScheduledPanel() {
  const search = useSearch({ strict: false }) as {
    readonly environmentId?: EnvironmentId;
    readonly taskId?: ScheduledTaskId;
  };
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} title="Scheduled" />
      <SidebarContent className="ci-panel">
        {connected.length === 0 ? (
          <p className="ci-panel__note">Connect a machine to schedule work on it.</p>
        ) : (
          connected.map((environment) => (
            <PanelMachineSchedules
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label.toLowerCase()}
              showHeading={connected.length > 1}
              selectedTaskId={search.taskId}
              selectedEnvironmentId={search.environmentId ?? primaryEnvironmentId}
            />
          ))
        )}
      </SidebarContent>
    </>
  );
}
