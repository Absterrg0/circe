import { scopeThreadRef } from "@circe/client/environment";
import type { EnvironmentId } from "@circe/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BookOpenIcon,
  BugIcon,
  GitBranchIcon,
  MonitorIcon,
  PackageIcon,
  ServerIcon,
} from "lucide-react";
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
import { CirceCommandConsole, type CirceCommandSuggestion } from "./CirceCommandConsole";
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

const SUGGESTIONS: ReadonlyArray<CirceCommandSuggestion> = [
  { label: "Fix failing tests", icon: <BugIcon />, text: "Fix the failing tests in " },
  {
    label: "Review open PRs",
    icon: <PullRequestGlyph.pullRequest />,
    text: "Review the open pull requests in ",
  },
  { label: "Update dependencies", icon: <PackageIcon />, text: "Update the dependencies in " },
  { label: "Explain a codebase", icon: <BookOpenIcon />, text: "Explain how this project works: " },
];

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

interface AgentSummary {
  readonly entry: ProviderInstanceEntry;
  readonly running: number;
  readonly machines: number;
  readonly ready: boolean;
}

/**
 * Circe's landing page: say what you want, then see what waits on you, what
 * is running, which pull requests are open, and which agents and machines are
 * up. Everything below the command box is a view over typed state the client
 * already holds; Home adds no subscriptions or host queries of its own.
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
  // One row per agent, however many machines run it, busiest first.
  const agents = useMemo(() => {
    const byName = new Map<string, AgentSummary>();
    for (const entries of providerEntries.values()) {
      for (const entry of entries.values()) {
        if (!entry.enabled) continue;
        const ready = entry.isAvailable && entry.status === "ready";
        const current = byName.get(entry.displayName);
        byName.set(entry.displayName, {
          entry: current?.entry ?? entry,
          running: current?.running ?? 0,
          machines: (current?.machines ?? 0) + 1,
          ready: (current?.ready ?? false) || ready,
        });
      }
    }
    for (const task of tasks.running) {
      const entry = providerEntries
        .get(task.thread.environmentId)
        ?.get(task.thread.runtime?.providerInstanceId ?? task.thread.modelSelection.instanceId);
      const current = entry === undefined ? undefined : byName.get(entry.displayName);
      if (current !== undefined && entry !== undefined) {
        byName.set(entry.displayName, { ...current, running: current.running + 1 });
      }
    }
    return [...byName.values()].toSorted(
      (left, right) =>
        right.running - left.running ||
        Number(right.ready) - Number(left.ready) ||
        left.entry.displayName.localeCompare(right.entry.displayName),
    );
  }, [providerEntries, tasks.running]);

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
  const readyAgents = agents.filter((agent) => agent.ready).length;
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
              <CirceCommandConsole catalog={catalog} suggestions={SUGGESTIONS} />
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

            <div className="circe-home__grid" data-columns={pullRequestsSupported ? 3 : 2}>
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

              <section className="circe-card" aria-label="Agents">
                <CirceCardHeader
                  title="Agents"
                  count={agents.length}
                  subtitle={agents.length > 0 ? `${readyAgents} ready` : undefined}
                  link={
                    <Link to="/settings/providers" className="circe-card__link">
                      <CirceCardLinkLabel>Manage</CirceCardLinkLabel>
                    </Link>
                  }
                />
                {agents.length === 0 ? (
                  <p className="circe-card__empty">
                    Turn on a coding agent in Settings to start working.
                  </p>
                ) : (
                  <ul className="circe-rows">
                    {agents.slice(0, 5).map((agent) => {
                      const tone: CirceTone =
                        agent.running > 0 ? "running" : agent.ready ? "done" : "attention";
                      return (
                        <li key={agent.entry.displayName}>
                          <div className="circe-row">
                            <span className="circe-row__icon">
                              <ProviderInstanceIcon
                                driverKind={agent.entry.driverKind}
                                displayName={agent.entry.displayName}
                                acpRegistryAgentId={agent.entry.acpRegistryAgentId}
                                acpRegistryIconUrl={agent.entry.acpRegistryIconUrl}
                                iconClassName="size-4"
                              />
                            </span>
                            <span className="circe-row__text">
                              <span className="circe-row__title">{agent.entry.displayName}</span>
                              {agent.machines > 1 ? (
                                <span className="circe-row__meta">
                                  <span>On {agent.machines} machines</span>
                                </span>
                              ) : null}
                            </span>
                            <span className="circe-state" data-tone={tone}>
                              <span className="circe-status-dot" aria-hidden />
                              {agent.running > 0
                                ? `${agent.running} running`
                                : agent.ready
                                  ? "Ready"
                                  : "Needs setup"}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section className="circe-card" aria-label="Machines">
                <CirceCardHeader
                  title="Machines"
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
                      const tone: CirceTone = !online ? "idle" : running > 0 ? "running" : "done";
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
                                </span>
                              </span>
                            </span>
                            <span className="circe-state" data-tone={tone}>
                              <span className="circe-status-dot" aria-hidden />
                              {!online ? "Offline" : running > 0 ? `${running} running` : "Online"}
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
