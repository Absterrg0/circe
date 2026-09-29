import { scopeProjectRef, scopeThreadRef } from "@circe/client/environment";
import { isChatWorkspace, type EnvironmentId } from "@circe/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  MonitorIcon,
  PlusIcon,
  ServerIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProjects, useThreadShells, useUserProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { CirceCommandConsole } from "./CirceCommandConsole";
import type { CirceControlCenterDevice } from "./CirceControlCenter.logic";
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

function relativeTime(timestamp: string): string {
  const label = formatRelativeTimeLabel(timestamp);
  return label === "just now" ? "now" : label.replace(/ ago$/, "");
}

function TaskRow({
  task,
  machineLabel,
  onOpen,
}: {
  readonly task: CirceHomeTask;
  readonly machineLabel: string | null;
  readonly onOpen: (task: CirceHomeTask) => void;
}) {
  const status = STATUS_PRESENTATION[task.status];
  const place = task.isChat ? "Chat" : (task.projectTitle ?? "Project");
  return (
    <li>
      <button
        type="button"
        className="circe-task-row"
        data-status={task.status}
        onClick={() => onOpen(task)}
      >
        <span className="circe-task-row__icon" role="img" aria-label={status.label}>
          {task.isChat && task.status === "ready" ? <MessagesSquareIcon /> : status.icon}
        </span>
        <span className="circe-task-row__text">
          <span className="circe-task-row__title">{task.thread.title}</span>
          <span className="circe-task-row__meta">
            {place}
            {machineLabel ? <> · {machineLabel}</> : null}
            {task.status !== "ready" ? <> · {status.label}</> : null}
          </span>
        </span>
        <span className="circe-task-row__time">
          {relativeTime(task.thread.latestUserMessageAt ?? task.thread.updatedAt)}
        </span>
      </button>
    </li>
  );
}

function HomeSection({
  title,
  count,
  action,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="circe-card" aria-label={title}>
      <header className="circe-card__header">
        <h2>
          {title}
          {count !== undefined && count > 0 ? <span className="circe-count">{count}</span> : null}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function TaskList({
  tasks,
  empty,
  machineLabelFor,
  onOpen,
}: {
  readonly tasks: ReadonlyArray<CirceHomeTask>;
  readonly empty: string;
  readonly machineLabelFor: (environmentId: EnvironmentId) => string | null;
  readonly onOpen: (task: CirceHomeTask) => void;
}) {
  if (tasks.length === 0) return <p className="circe-card__empty">{empty}</p>;
  return (
    <ul className="circe-task-list">
      {tasks.map((task) => (
        <TaskRow
          key={`${task.thread.environmentId}:${task.thread.id}`}
          task={task}
          machineLabel={machineLabelFor(task.thread.environmentId)}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}

function projectCountLabel(count: number): string {
  return count === 1 ? "1 project" : `${count} projects`;
}

function MachineRow({
  device,
  running,
  onOpen,
}: {
  readonly device: CirceControlCenterDevice;
  readonly running: number;
  readonly onOpen: () => void;
}) {
  const online = device.node.reachability === "online";
  const headless = device.node.capabilities?.ui === false;
  return (
    <li>
      <button type="button" className="circe-machine-row" onClick={onOpen}>
        <span className="circe-machine-row__icon">
          {headless ? <ServerIcon /> : <MonitorIcon />}
        </span>
        <span className="circe-task-row__text">
          <span className="circe-task-row__title">{device.node.label}</span>
          <span className="circe-task-row__meta">
            {device.isCurrentDevice ? "This device · " : ""}
            {online
              ? running > 0
                ? `${running} running`
                : projectCountLabel(
                    device.projects.filter((project) => !isChatWorkspace(project)).length,
                  )
              : "Offline"}
          </span>
        </span>
        <span className="circe-status-dot" data-online={online} aria-hidden />
        <ChevronRightIcon aria-hidden className="circe-machine-row__chevron" />
      </button>
    </li>
  );
}

/**
 * Circe's landing page: say what you want, see what is waiting on you, and
 * see which machines are up. Everything here is a view over typed state; the
 * only control is the command console.
 */
export function CirceHome() {
  const navigate = useNavigate();
  const now = useNowMinute();
  const threads = useThreadShells();
  const projects = useProjects();
  const userProjects = useUserProjects();
  const handleNewThread = useNewThreadHandler();
  const { environments } = useEnvironments();
  const { catalog, view } = useCirceMeshCatalog();

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

  const openTask = (task: CirceHomeTask) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(task.thread.environmentId, task.thread.id)),
    });
  };
  const startTask = () => {
    const [onlyProject] = userProjects;
    if (userProjects.length === 0) {
      openCommandPalette({ open: "add-project" });
    } else if (userProjects.length === 1 && onlyProject !== undefined) {
      void handleNewThread(scopeProjectRef(onlyProject.environmentId, onlyProject.id));
    } else {
      openCommandPalette({ open: "new-thread-in" });
    }
  };

  const summary = [
    tasks.needsYou.length > 0
      ? `${tasks.needsYou.length} ${tasks.needsYou.length === 1 ? "task needs" : "tasks need"} you`
      : null,
    tasks.running.length > 0 ? `${tasks.running.length} running` : null,
    view.summary.devices > 0
      ? `${view.summary.onlineDevices} of ${view.summary.devices} ${view.summary.devices === 1 ? "machine" : "machines"} online`
      : null,
  ].filter((part) => part !== null);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="text-sm font-semibold">Home</h1>
          <div className="ms-auto flex items-center gap-2">
            <Button size="xs" variant="outline" onClick={startTask}>
              <PlusIcon />
              {userProjects.length === 0 ? "Add project" : "New task"}
            </Button>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="circe-home">
            <header className="circe-home__intro">
              <h2>{greetingForHour(new Date(now).getHours())}</h2>
              <p>{summary.length > 0 ? summary.join(" · ") : "Nothing needs you right now."}</p>
            </header>
            <CirceCommandConsole catalog={catalog} />
            <div className="circe-home__grid">
              <HomeSection title="Needs you" count={tasks.needsYou.length}>
                <TaskList
                  tasks={tasks.needsYou}
                  empty="Nothing is waiting on you."
                  machineLabelFor={machineLabelFor}
                  onOpen={openTask}
                />
              </HomeSection>
              <HomeSection title="Running" count={tasks.running.length}>
                <TaskList
                  tasks={tasks.running}
                  empty="No agents are working."
                  machineLabelFor={machineLabelFor}
                  onOpen={openTask}
                />
              </HomeSection>
              <HomeSection title="Recent">
                <TaskList
                  tasks={tasks.recent}
                  empty="Finished work shows up here."
                  machineLabelFor={machineLabelFor}
                  onOpen={openTask}
                />
              </HomeSection>
              <HomeSection
                title="Machines"
                count={view.summary.devices}
                action={
                  <button
                    type="button"
                    className="circe-text-action"
                    onClick={() => void navigate({ to: "/machines" })}
                  >
                    Manage
                  </button>
                }
              >
                {view.devices.length === 0 ? (
                  <p className="circe-card__empty">
                    No machines connected.{" "}
                    <button
                      type="button"
                      className="circe-text-action"
                      onClick={() => void navigate({ to: "/settings/connections" })}
                    >
                      Pair one
                    </button>
                  </p>
                ) : (
                  <ul className="circe-task-list">
                    {view.devices.map((device) => (
                      <MachineRow
                        key={device.node.nodeId}
                        device={device}
                        running={runningByNode.get(device.node.nodeId) ?? 0}
                        onOpen={() =>
                          void navigate({ to: "/machines", search: { node: device.node.nodeId } })
                        }
                      />
                    ))}
                  </ul>
                )}
              </HomeSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
