import { scopeThreadRef } from "@circe/client/environment";
import type { EnvironmentId } from "@circe/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useStartNewWork } from "../../hooks/useStartNewWork";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { CirceCommandConsole } from "./CirceCommandConsole";
import { buildCirceHomeTasks, greetingForHour, type CirceHomeTask } from "./CirceHome.logic";
import { useCirceMeshCatalog } from "./useCirceMeshCatalog";
import "./circe-pages.css";

const STATUS_PRESENTATION: Record<
  CirceHomeTask["status"],
  { readonly label: string; readonly icon: ReactNode }
> = {
  approval: { label: "Needs approval", icon: <ShieldQuestionIcon /> },
  input: { label: "Has a question", icon: <MessageCircleQuestionIcon /> },
  failed: { label: "Failed", icon: <CircleAlertIcon /> },
  working: { label: "Working", icon: <CircleDashedIcon /> },
  waiting: { label: "Waiting on tasks", icon: <CircleDashedIcon /> },
  ready: { label: "Done", icon: <CircleCheckIcon /> },
};

type HomeTab = "needsYou" | "running" | "recent";

function relativeTime(timestamp: string): string {
  const label = formatRelativeTimeLabel(timestamp);
  return label === "just now" ? "now" : label.replace(/ ago$/, "");
}

function TaskRow({
  task,
  machineLabel,
}: {
  readonly task: CirceHomeTask;
  readonly machineLabel: string | null;
}) {
  const status = STATUS_PRESENTATION[task.status];
  const place = task.isChat ? "Chat" : (task.projectTitle ?? "Project");
  return (
    <li>
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(task.thread.environmentId, task.thread.id))}
        className="circe-task-row"
        data-status={task.status}
      >
        <span className="circe-task-row__icon" role="img" aria-label={status.label}>
          {task.isChat && task.status === "ready" ? <MessagesSquareIcon /> : status.icon}
        </span>
        <span className="circe-task-row__text">
          <span className="circe-task-row__title">{task.thread.title}</span>
          <span className="circe-task-row__meta">
            {place}
            {machineLabel ? <> · {machineLabel}</> : null}
          </span>
        </span>
        {task.status !== "ready" ? (
          <span className="circe-task-row__state">{status.label}</span>
        ) : null}
        <span className="circe-task-row__time">
          {relativeTime(task.thread.latestUserMessageAt ?? task.thread.updatedAt)}
        </span>
      </Link>
    </li>
  );
}

/**
 * Circe's landing page: say what you want, then see what waits on you, what
 * is running, and which machines are up. Everything below the command box is
 * a view over typed state.
 */
export function CirceHome() {
  const navigate = useNavigate();
  const now = useNowMinute();
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { catalog, view } = useCirceMeshCatalog();
  const { addProject, hasProjects } = useStartNewWork();
  const [chosenTab, setChosenTab] = useState<HomeTab | null>(null);

  const workspaceByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const tasks = useMemo(
    () => buildCirceHomeTasks({ threads, workspaceByKey, now }),
    [now, threads, workspaceByKey],
  );
  // Name the machine only when there is more than one to tell apart.
  const machineLabels = useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          environment.serverConfig?.environment.label ?? environment.label,
        ]),
      ),
    [environments],
  );
  const machineLabelFor = (environmentId: EnvironmentId) =>
    machineLabels.size > 1 ? (machineLabels.get(environmentId) ?? null) : null;
  const runningByNode = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks.running) {
      counts.set(task.thread.environmentId, (counts.get(task.thread.environmentId) ?? 0) + 1);
    }
    return counts;
  }, [tasks.running]);

  // Open on what matters most until the user picks a tab.
  const tab: HomeTab =
    chosenTab ??
    (tasks.needsYou.length > 0 ? "needsYou" : tasks.running.length > 0 ? "running" : "recent");
  const tabs: ReadonlyArray<{
    readonly id: HomeTab;
    readonly label: string;
    readonly tasks: ReadonlyArray<CirceHomeTask>;
    readonly empty: ReactNode;
  }> = [
    {
      id: "needsYou",
      label: "Needs you",
      tasks: tasks.needsYou,
      empty: "Nothing is waiting on you.",
    },
    {
      id: "running",
      label: "Running",
      tasks: tasks.running,
      empty: hasProjects ? (
        "No agents are working."
      ) : (
        <>
          Add a project to run coding agents on it.{" "}
          <button type="button" className="circe-text-action" onClick={addProject}>
            Add project
          </button>
        </>
      ),
    },
    { id: "recent", label: "Recent", tasks: tasks.recent, empty: "Finished work shows up here." },
  ];
  const activeTab = tabs.find((candidate) => candidate.id === tab)!;
  const summary =
    tasks.needsYou.length > 0
      ? `${tasks.needsYou.length} ${tasks.needsYou.length === 1 ? "task needs" : "tasks need"} you.`
      : tasks.running.length > 0
        ? `${tasks.running.length} ${tasks.running.length === 1 ? "agent is" : "agents are"} working.`
        : "What should we work on?";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} aria-label="Home">
          <h1 className="sr-only">Home</h1>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="circe-home">
            <header className="circe-home__intro">
              <h2>{greetingForHour(new Date(now).getHours())}</h2>
              <p>{summary}</p>
            </header>
            <CirceCommandConsole catalog={catalog} />

            <section className="circe-home__work" aria-label="Your work">
              <div className="circe-tabs" role="tablist" aria-label="Task views">
                {tabs.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="tab"
                    id={`home-tab-${candidate.id}`}
                    aria-selected={candidate.id === tab}
                    aria-controls="home-tab-panel"
                    className="circe-tab"
                    onClick={() => setChosenTab(candidate.id)}
                  >
                    {candidate.label}
                    {candidate.id !== "recent" && candidate.tasks.length > 0 ? (
                      <span className="circe-count" data-tone={candidate.id}>
                        {candidate.tasks.length}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
              <div id="home-tab-panel" role="tabpanel" aria-labelledby={`home-tab-${tab}`}>
                {activeTab.tasks.length === 0 ? (
                  <p className="circe-section__empty">{activeTab.empty}</p>
                ) : (
                  <ul className="circe-task-list">
                    {activeTab.tasks.map((task) => (
                      <TaskRow
                        key={`${task.thread.environmentId}:${task.thread.id}`}
                        task={task}
                        machineLabel={machineLabelFor(task.thread.environmentId)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="circe-home__machines" aria-label="Machines">
              <h2>Machines</h2>
              {view.devices.length === 0 ? (
                <button
                  type="button"
                  className="circe-text-action"
                  onClick={() => void navigate({ to: "/settings/connections" })}
                >
                  Pair a machine
                </button>
              ) : (
                <ul>
                  {view.devices.map((device) => {
                    const online = device.node.reachability === "online";
                    const running = runningByNode.get(device.node.nodeId) ?? 0;
                    return (
                      <li key={device.node.nodeId}>
                        <Link
                          to="/machines"
                          search={{ node: device.node.nodeId }}
                          className="circe-machine-pill"
                        >
                          <span className="circe-status-dot" data-online={online} aria-hidden />
                          {device.node.label}
                          <span className="circe-machine-pill__meta">
                            {!online
                              ? "Offline"
                              : running > 0
                                ? `${running} running`
                                : device.isCurrentDevice
                                  ? "This device"
                                  : "Online"}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
