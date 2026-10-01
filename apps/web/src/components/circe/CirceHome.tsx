import { scopeThreadRef } from "@circe/client/environment";
import type { EnvironmentId } from "@circe/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { GitBranchIcon, MonitorIcon, ServerIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useStartNewWork } from "../../hooks/useStartNewWork";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useProjects, useServerConfigs, useThreadShells } from "../../state/entities";
import { useEnvironments, usePullRequestsSupported } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { CirceCardHeader, CirceCardLinkLabel } from "./CirceCard";
import { CirceCommandConsole } from "./CirceCommandConsole";
import {
  buildCirceHomeTasks,
  collectCirceHomePullRequests,
  formatElapsed,
  greetingForHour,
  type CirceHomePullRequest,
  type CirceHomePullRequestReadiness,
  type CirceHomeTask,
} from "./CirceHome.logic";
import { CirceStatusGlyph, toneForTaskStatus, type CirceTone } from "./CirceStatusGlyph";
import { useCirceMeshCatalog } from "./useCirceMeshCatalog";
import "./circe-pages.css";

const STATUS_LABEL: Record<CirceHomeTask["status"], string> = {
  approval: "Needs approval",
  input: "Has a question",
  failed: "Failed",
  working: "Running",
  waiting: "Waiting",
  ready: "Done",
};

const PULL_REQUEST_STATE: Record<
  CirceHomePullRequestReadiness,
  { readonly label: string; readonly tone: CirceTone }
> = {
  ready: { label: "Ready to merge", tone: "done" },
  review: { label: "Needs review", tone: "attention" },
  changes: { label: "Changes requested", tone: "attention" },
  failing: { label: "Checks failing", tone: "failed" },
  draft: { label: "Draft", tone: "idle" },
};

type HomeTab = "needsYou" | "running" | "recent";

function presetLabel(preset: string | undefined): string {
  return preset === undefined ? "Machine" : preset[0]!.toUpperCase() + preset.slice(1);
}

function relativeTime(timestamp: string): string {
  const label = formatRelativeTimeLabel(timestamp);
  return label === "just now" ? "now" : label.replace(/ ago$/, "");
}

function TaskRow({
  task,
  now,
  machineLabel,
  provider,
}: {
  readonly task: CirceHomeTask;
  readonly now: string;
  readonly machineLabel: string | null;
  readonly provider: ProviderInstanceEntry | null;
}) {
  const { thread } = task;
  const tone = toneForTaskStatus(task.status);
  const label = STATUS_LABEL[task.status];
  const startedAt = thread.runtime?.activityStartedAt ?? null;
  const time =
    task.status === "working" && startedAt !== null
      ? formatElapsed(startedAt, now)
      : relativeTime(thread.latestUserMessageAt ?? thread.updatedAt);
  const model = provider?.models.find(
    (candidate) => candidate.slug === thread.modelSelection.model,
  );
  const modelLabel = model ? getTriggerDisplayModelLabel(model) : thread.modelSelection.model;
  return (
    <li>
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
        className="circe-row circe-task-row"
      >
        <CirceStatusGlyph tone={tone} label={label} />
        <span className="circe-row__text">
          <span className="circe-row__title">{thread.title}</span>
          <span className="circe-row__meta">
            <span>{task.isChat ? "Chat" : (task.projectTitle ?? "Project")}</span>
            {thread.branch ? (
              <>
                <GitBranchIcon aria-hidden />
                <span>{thread.branch}</span>
              </>
            ) : null}
            {machineLabel ? <span>· {machineLabel}</span> : null}
          </span>
        </span>
        {provider ? (
          <span className="circe-tag">
            <ProviderInstanceIcon
              driverKind={provider.driverKind}
              displayName={provider.displayName}
              acpRegistryAgentId={provider.acpRegistryAgentId}
              acpRegistryIconUrl={provider.acpRegistryIconUrl}
              iconClassName="size-3.5"
            />
            <span>{modelLabel}</span>
          </span>
        ) : null}
        <span className="circe-task-row__status">
          <span className="circe-state" data-tone={tone}>
            {label}
          </span>
          <span className="circe-row__time">{time}</span>
        </span>
      </Link>
    </li>
  );
}

function PullRequestRow({ pullRequest }: { readonly pullRequest: CirceHomePullRequest }) {
  const { link, thread } = pullRequest;
  const state = PULL_REQUEST_STATE[pullRequest.readiness];
  const { additions, deletions } = link.snapshot;
  return (
    <li>
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
        className="circe-row"
      >
        <span className="circe-row__icon" data-tone={state.tone}>
          {pullRequest.readiness === "draft" ? (
            <PullRequestGlyph.draft />
          ) : pullRequest.readiness === "failing" ? (
            <PullRequestGlyph.conflicting />
          ) : (
            <PullRequestGlyph.pullRequest />
          )}
        </span>
        <span className="circe-row__text">
          <span className="circe-row__title">{link.snapshot.title}</span>
          <span className="circe-row__meta">
            <span>
              #{link.number} · {link.repository.split("/").at(-1)}
            </span>
          </span>
        </span>
        <span className="circe-row__aside">
          <span className="circe-state" data-tone={state.tone}>
            <span className="circe-status-dot" aria-hidden />
            {state.label}
          </span>
          {additions !== undefined && deletions !== undefined ? (
            <span
              className="circe-diffstat"
              aria-label={`${additions} added, ${deletions} removed`}
            >
              <span>+{additions}</span>
              <span>−{deletions}</span>
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

/**
 * Circe's landing page: say what you want, then see what waits on you, what
 * is running, which pull requests are open, and which devices are up and what
 * each one runs. Everything below the command box is a view over typed state
 * the client already holds; Home adds no subscriptions or host queries of its
 * own.
 */
export function CirceHome() {
  const navigate = useNavigate();
  const now = useNowMinute();
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const pullRequestsSupported = usePullRequestsSupported();
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
  const pullRequests = useMemo(() => collectCirceHomePullRequests(threads), [threads]);
  // Instance ids are driver slugs per machine, so entries resolve per environment.
  const providerEntries = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers, config.settings] as const,
        ),
      ),
    [serverConfigs],
  );
  const providerFor = (task: CirceHomeTask) =>
    providerEntries
      .get(task.thread.environmentId)
      ?.get(task.thread.runtime?.providerInstanceId ?? task.thread.modelSelection.instanceId) ??
    null;
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
    readonly tone: CirceTone;
    readonly empty: ReactNode;
  }> = [
    {
      id: "needsYou",
      label: "Needs you",
      tasks: tasks.needsYou,
      tone: "attention",
      empty: "Nothing is waiting on you.",
    },
    {
      id: "running",
      label: "Running",
      tasks: tasks.running,
      tone: "running",
      empty: hasProjects ? (
        "No agents are working right now."
      ) : (
        <>
          Add a project to run coding agents on it.
          <button type="button" className="circe-text-action" onClick={addProject}>
            Add project
          </button>
        </>
      ),
    },
    {
      id: "recent",
      label: "Recent",
      tasks: tasks.recent,
      tone: "idle",
      empty: "Finished work shows up here.",
    },
  ];
  const activeTab = tabs.find((candidate) => candidate.id === tab)!;
  const hour = new Date(now.length === 16 ? `${now}:00.000Z` : now).getHours();
  const summary =
    tasks.needsYou.length > 0
      ? `${tasks.needsYou.length} ${tasks.needsYou.length === 1 ? "task needs" : "tasks need"} you${
          tasks.running.length > 0 ? `, ${tasks.running.length} running.` : "."
        }`
      : tasks.running.length > 0
        ? `${tasks.running.length} ${tasks.running.length === 1 ? "agent is" : "agents are"} working. Nothing needs you.`
        : "Tell Circe what to do. It picks the machine and project, and asks when it isn't sure.";
  const onlineMachines = view.devices.filter(
    (device) => device.node.reachability === "online",
  ).length;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="relative isolate flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="circe-home__glow" aria-hidden />
        <WorkspacePageHeader electron={isElectron} aria-label="Home">
          <h1 className="sr-only">Home</h1>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="circe-home">
            <section className="circe-home__hero" aria-label="Tell Circe">
              <header className="circe-home__greeting">
                <h2>
                  {greetingForHour(hour)}
                  <span>.</span>
                </h2>
                <p>{summary}</p>
              </header>
              <CirceCommandConsole catalog={catalog} />
            </section>

            <section className="circe-card circe-home__work" aria-label="Your tasks">
              <CirceCardHeader
                title={
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
                          <span className="circe-count" data-tone={candidate.tone}>
                            {candidate.tasks.length}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                }
              />
              <div id="home-tab-panel" role="tabpanel" aria-labelledby={`home-tab-${tab}`}>
                {activeTab.tasks.length === 0 ? (
                  <p className="circe-card__empty">{activeTab.empty}</p>
                ) : (
                  <ul className="circe-rows">
                    {activeTab.tasks.map((task) => (
                      <TaskRow
                        key={`${task.thread.environmentId}:${task.thread.id}`}
                        task={task}
                        now={now}
                        machineLabel={machineLabelFor(task.thread.environmentId)}
                        provider={providerFor(task)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <div className="circe-home__grid" data-columns={pullRequestsSupported ? 2 : 1}>
              {pullRequestsSupported ? (
                <section className="circe-card" aria-label="Pull requests">
                  <CirceCardHeader
                    title="Pull requests"
                    count={pullRequests.total}
                    countTone="running"
                    link={
                      <Link
                        to="/pull-requests"
                        search={readPullRequestListPreferences()}
                        className="circe-card__link"
                      >
                        <CirceCardLinkLabel>View all</CirceCardLinkLabel>
                      </Link>
                    }
                  />
                  {pullRequests.items.length === 0 ? (
                    <p className="circe-card__empty">
                      Pull requests your agents open or link show up here.
                    </p>
                  ) : (
                    <ul className="circe-rows">
                      {pullRequests.items.map((pullRequest) => (
                        <PullRequestRow key={pullRequest.key} pullRequest={pullRequest} />
                      ))}
                    </ul>
                  )}
                </section>
              ) : null}

              <section className="circe-card" aria-label="Devices">
                <CirceCardHeader
                  title="Devices"
                  count={view.devices.length}
                  subtitle={view.devices.length > 0 ? `${onlineMachines} online` : undefined}
                  link={
                    <Link to="/machines" className="circe-card__link">
                      <CirceCardLinkLabel>View all</CirceCardLinkLabel>
                    </Link>
                  }
                />
                {view.devices.length === 0 ? (
                  <p className="circe-card__empty">
                    No machines yet.
                    <button
                      type="button"
                      className="circe-text-action"
                      onClick={() => void navigate({ to: "/settings/connections" })}
                    >
                      Pair a machine
                    </button>
                  </p>
                ) : (
                  <ul className="circe-rows">
                    {view.devices.slice(0, 5).map((device) => {
                      const online = device.node.reachability === "online";
                      const running = runningByNode.get(device.node.nodeId) ?? 0;
                      const ready = device.providers.filter(
                        (provider) => provider.available,
                      ).length;
                      const tone: CirceTone = !online
                        ? "idle"
                        : running > 0
                          ? "running"
                          : ready === 0
                            ? "attention"
                            : "done";
                      return (
                        <li key={device.node.nodeId}>
                          <Link
                            to="/machines"
                            search={{ node: device.node.nodeId }}
                            className="circe-row"
                          >
                            <span className="circe-row__icon">
                              {device.node.capabilities?.ui === false ? (
                                <ServerIcon />
                              ) : (
                                <MonitorIcon />
                              )}
                            </span>
                            <span className="circe-row__text">
                              <span className="circe-row__title">{device.node.label}</span>
                              <span className="circe-row__meta">
                                <span>
                                  {device.isCurrentDevice
                                    ? "This device"
                                    : presetLabel(device.node.capabilities?.preset)}
                                  {device.projects.length > 0
                                    ? ` · ${device.projects.length} ${device.projects.length === 1 ? "project" : "projects"}`
                                    : ""}
                                  {device.providers.length > 0
                                    ? ` · ${ready}/${device.providers.length} agents`
                                    : ""}
                                </span>
                              </span>
                            </span>
                            {device.providers.length > 0 ? (
                              <span
                                className="circe-device-agents"
                                aria-label={`${ready} of ${device.providers.length} agents ready`}
                              >
                                {device.providers.slice(0, 4).map((provider) => (
                                  <ProviderInstanceIcon
                                    key={provider.snapshot.instanceId}
                                    driverKind={provider.snapshot.driver}
                                    displayName={
                                      provider.snapshot.displayName ?? provider.snapshot.driver
                                    }
                                    iconClassName={
                                      provider.available ? "size-4" : "size-4 opacity-40"
                                    }
                                  />
                                ))}
                              </span>
                            ) : null}
                            <span className="circe-state" data-tone={tone}>
                              <span className="circe-status-dot" aria-hidden />
                              {!online
                                ? "Offline"
                                : running > 0
                                  ? `${running} running`
                                  : ready === 0
                                    ? "Needs setup"
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
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
