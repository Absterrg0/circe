import { squashAtomCommandFailure } from "@circe/client/state/runtime";
import {
  isChatWorkspace,
  type EnvironmentId,
  type CirceProjectRef,
  type CirceTaskPendingReply,
  type CirceTaskRef,
  type CirceTaskState,
  type ThreadId,
} from "@circe/contracts";
import type { CirceMeshCatalog, CirceMeshNode } from "@circe/client-runtime/circe/mesh";
import { useNavigate } from "@tanstack/react-router";
import {
  MicIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ActivityIcon,
  CircleAlertIcon,
  FolderGit2Icon,
  ListTodoIcon,
  MonitorIcon,
  RefreshCwIcon,
  ServerIcon,
  Settings2Icon,
  WifiOffIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import {
  getCirceLastCommandFeedback,
  getCirceTargetSnapshot,
  getCirceCommandState,
  requestCirceCommandAction,
  onCirceCommandFeedback,
  onCirceCommandState,
  onCirceTargetSnapshot,
  requestCirceTarget,
  submitCirceComposerCommand,
  type CirceCommandFeedback,
  type CirceTargetSnapshot,
} from "../../circeBus";
import { cn, randomUUID } from "../../lib/utils";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { circeMeshEnvironment } from "../../state/circeMesh";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getCirceLiveVoiceUiState,
  setCirceLiveVoiceActive,
  subscribeCirceLiveVoice,
} from "./CirceLiveVoice.bridge";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { CIRCE_MARK_SRC } from "./CirceBrand";
import {
  buildCirceControlCenterView,
  type CirceControlCenterDevice,
  type CirceControlCenterView,
} from "./CirceControlCenter.logic";
import { circeErrorMessage } from "./CirceManager.logic";
import { buildCirceVoiceWaitingView } from "@circe/client-runtime/circe/voiceWaiting";
import { CirceLiveAgents } from "./CirceLiveAgents";
import { CirceMeshDevices } from "./CirceMeshDevices";
import { CirceComputerSection } from "./CirceComputerSection";
import { CirceNodeAgentSettings } from "./CirceNodeAgentSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { circePresenceMode } from "./CircePresence.logic";
import { CirceOrb, type CirceOrbState } from "./CirceOrb";
import "./CirceControlCenter.css";

const EMPTY_CATALOG: CirceMeshCatalog = { nodes: [], projects: [], providers: [] };

function StatusDot({ online }: { readonly online: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("circe-status-dot shrink-0", online && "circe-status-dot-live")}
    />
  );
}

/** Where each machine sits around Circe, as percentages of the map. */
export function constellationPositions(count: number): ReadonlyArray<{ x: number; y: number }> {
  if (count === 0) return [];
  if (count === 1) return [{ x: 80, y: 50 }];
  const start = count === 2 ? 180 : -90;
  return Array.from({ length: count }, (_, index) => {
    const angle = ((start + (360 * index) / count) * Math.PI) / 180;
    return {
      x: Math.round((50 + 34 * Math.cos(angle)) * 10) / 10,
      y: Math.round((50 + 34 * Math.sin(angle)) * 10) / 10,
    };
  });
}

/**
 * Every connected machine drawn around Circe. Selecting a machine scopes the
 * rail below to it; the map is also the device picker.
 */
function DeviceConstellation({
  devices,
  selectedNodeId,
  onSelect,
  summary,
}: {
  readonly devices: ReadonlyArray<CirceControlCenterDevice>;
  readonly selectedNodeId: EnvironmentId | null;
  readonly onSelect: (nodeId: EnvironmentId) => void;
  readonly summary: CirceControlCenterView["summary"];
}) {
  const positions = constellationPositions(devices.length);
  const center = devices.length === 1 ? { x: 24, y: 50 } : { x: 50, y: 50 };
  return (
    <section className="circe-constellation" aria-label="Your machines">
      <header className="circe-rail-heading">
        <h3>Machines</h3>
        <span className="circe-summary">
          <StatusDot online={summary.onlineDevices > 0} />
          {summary.onlineDevices} of {summary.devices} online
        </span>
      </header>
      <div className="circe-constellation__map">
        <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none">
          {devices.map((device, index) => {
            const position = positions[index]!;
            return (
              <line
                key={device.node.nodeId}
                x1={center.x}
                y1={center.y}
                x2={position.x}
                y2={position.y}
                data-online={device.node.reachability === "online"}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>
        <span
          className="circe-constellation__center"
          style={{ left: `${center.x}%`, top: `${center.y}%` }}
        >
          <CirceOrb size="md" />
        </span>
        {devices.map((device, index) => {
          const position = positions[index]!;
          const online = device.node.reachability === "online";
          const selected = device.node.nodeId === selectedNodeId;
          return (
            <button
              key={device.node.nodeId}
              type="button"
              aria-pressed={selected}
              className="circe-constellation__node"
              data-online={online}
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
              onClick={() => onSelect(device.node.nodeId)}
            >
              <span className="circe-constellation__glyph">
                {device.node.capabilities?.ui === false ? (
                  <ServerIcon className="size-3.5" />
                ) : (
                  <MonitorIcon className="size-3.5" />
                )}
                <StatusDot online={online} />
              </span>
              <span className="circe-constellation__label">{device.node.label}</span>
              {device.isCurrentDevice ? (
                <span className="circe-constellation__tag">This device</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function DeviceHero({ device }: { readonly device: CirceControlCenterDevice }) {
  const online = device.node.reachability === "online";
  return (
    <section className="circe-device-info">
      <span className="circe-device-icon">
        {device.node.capabilities?.ui === false ? (
          <ServerIcon className="size-4" />
        ) : (
          <MonitorIcon className="size-4" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <h2>{device.node.label}</h2>
        <p>
          {device.isCurrentDevice ? "This device" : "Connected machine"}
          <span aria-hidden> · </span>
          {device.node.capabilities?.preset ?? "Unknown preset"}
        </p>
      </div>
      <span className="circe-device-state" data-online={online}>
        <StatusDot online={online} />
        {online ? "Online" : "Offline"}
      </span>
      {device.node.catalogError ? (
        <p className="circe-device-error">
          <WifiOffIcon className="size-3.5" />
          {device.node.catalogError}
        </p>
      ) : null}
    </section>
  );
}

function ProviderSection({
  providers,
  onManage,
}: {
  readonly providers: CirceControlCenterDevice["providers"];
  readonly onManage: () => void;
}) {
  return (
    <section className="circe-provider-section">
      <div className="circe-section-heading">
        <h3>
          Providers <span className="circe-inline-count">{providers.length}</span>
        </h3>
        <button type="button" onClick={onManage} className="circe-text-action">
          Manage
        </button>
      </div>
      {providers.length === 0 ? (
        <p className="circe-muted-note">Connect a provider to start working.</p>
      ) : (
        <div className="circe-provider-list">
          {providers.map((provider) => {
            const state = provider.available
              ? "Ready"
              : !provider.snapshot.enabled
                ? "Disabled"
                : "Needs setup";
            return (
              <div className="circe-provider-row" key={provider.snapshot.instanceId}>
                <span className="circe-provider-icon">
                  <ProviderInstanceIcon
                    driverKind={provider.snapshot.driver}
                    displayName={provider.snapshot.displayName ?? provider.snapshot.driver}
                    iconClassName="size-[18px]"
                  />
                </span>
                <span className="circe-provider-name">
                  {provider.snapshot.displayName ?? provider.snapshot.driver}
                </span>
                <span className="circe-provider-state" data-ready={provider.available}>
                  <StatusDot online={provider.available} />
                  {state}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ProjectSection({ projects }: { readonly projects: CirceControlCenterDevice["projects"] }) {
  return (
    <details className="circe-project-section">
      <summary className="circe-section-heading">
        <span>
          Projects <span className="circe-inline-count">{projects.length}</span>
        </span>
        <ChevronDownIcon className="size-4" />
      </summary>
      {projects.length === 0 ? (
        <p className="circe-muted-note">No projects available.</p>
      ) : (
        <div className="circe-project-list">
          {projects.map((project) => (
            <div className="circe-project-row" key={project.ref.projectId}>
              <FolderGit2Icon className="size-3.5 shrink-0" />
              <div className="min-w-0">
                <p>{project.title}</p>
                <Tooltip>
                  <TooltipTrigger render={<span tabIndex={0} />}>
                    {project.workspaceRoot}
                  </TooltipTrigger>
                  <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

export function CirceCommandConsole({ catalog }: { readonly catalog: CirceMeshCatalog | null }) {
  const [draft, setDraft] = useState("");
  const [activityView, setActivityView] = useState<"recent" | "active">("recent");
  const [feedback, setFeedback] = useState<CirceCommandFeedback | null>(() =>
    getCirceLastCommandFeedback(),
  );
  const [targetSnapshot, setTargetSnapshot] = useState<CirceTargetSnapshot | null>(() =>
    getCirceTargetSnapshot(),
  );
  const [commandState, setCommandState] = useState(getCirceCommandState);
  const { pending: commandPending, busy: commandBusy, awaitingAnswer, canRetry } = commandState;
  const [tasks, setTasks] = useState<
    ReadonlyArray<{
      threadId: ThreadId;
      title: string;
      state: CirceTaskState;
      projectRef: CirceProjectRef;
      taskRef?: CirceTaskRef;
      pendingReply?: CirceTaskPendingReply | null;
    }>
  >([]);
  const [liveVoice, setLiveVoice] = useState(getCirceLiveVoiceUiState);
  const getTaskDesk = useAtomCommand(circeMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(() => onCirceCommandFeedback((entry) => setFeedback(entry)), []);
  useEffect(() => subscribeCirceLiveVoice(() => setLiveVoice(getCirceLiveVoiceUiState())), []);
  useEffect(() => onCirceTargetSnapshot((snapshot) => setTargetSnapshot(snapshot)), []);
  useEffect(() => onCirceCommandState(setCommandState), []);

  // Keep the task desk useful before the user chooses an explicit project.
  // Once a target exists, its qualified node always wins so work cannot bleed
  // across nodes.
  const selectedNodeId =
    targetSnapshot?.projectRef?.nodeId ??
    catalog?.nodes.find((node) => node.reachability === "online")?.nodeId ??
    null;
  useEffect(() => {
    // Drop rows the moment the selected node changes so a stale row from
    // another node can never be picked; failures clear them the same way.
    setTasks([]);
    if (selectedNodeId === null) return;
    let active = true;
    void getTaskDesk({ nodeId: selectedNodeId }).then((result) => {
      if (!active) return;
      if (result._tag !== "Success") {
        setTasks([]);
        return;
      }
      setTasks(
        result.value.recentTasks.map((task) => ({
          threadId: task.threadId,
          title: task.title,
          state: task.state,
          projectRef: task.projectRef,
          taskRef: task.taskRef,
          ...(task.pendingReply === undefined ? {} : { pendingReply: task.pendingReply }),
        })),
      );
    });
    return () => {
      active = false;
    };
  }, [getTaskDesk, selectedNodeId, targetSnapshot?.contextThreadId]);

  // Busy means a submission is on the wire; waiting means the runtime owns
  // paused or queued work and the answer goes through Send. Selectors stay
  // locked until the prompt resolves so an answer cannot land on a new
  // target. Both come from typed runtime state, not feedback wording.
  const sendDisabled = draft.trim().length === 0 || commandBusy;
  const sendDraft = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || commandBusy) return;
    setDraft("");
    submitCirceComposerCommand({ text, inputMode: "text", captureId: randomUUID() });
  }, [commandBusy, draft]);

  const cancelPending = useCallback(() => {
    if (commandPending || canRetry) {
      requestCirceCommandAction({ type: "cancel", inputMode: "text" });
    }
    setDraft("");
  }, [commandPending, canRetry]);

  // Targets are codebases; questions that are not about one go to the chat
  // space without being picked.
  const projects = (catalog?.projects ?? []).filter((project) => !isChatWorkspace(project));
  const targetProject = projects.find(
    (project) =>
      project.ref.nodeId === targetSnapshot?.projectRef?.nodeId &&
      project.ref.projectId === targetSnapshot?.projectRef?.projectId,
  );
  const targetNode = catalog?.nodes.find(
    (node) => node.nodeId === targetSnapshot?.projectRef?.nodeId,
  );
  const targetLabel =
    targetSnapshot?.projectRef === null || targetSnapshot?.projectRef === undefined
      ? "No explicit target"
      : `${targetSnapshot.projectTitle ?? targetProject?.title ?? "Project unavailable"} — ${targetSnapshot.nodeLabel ?? targetNode?.label ?? "Device unavailable"}${
          targetSnapshot.contextThreadTitle !== undefined
            ? ` · ${targetSnapshot.contextThreadTitle}`
            : targetSnapshot.contextThreadId !== undefined
              ? ` · ${targetSnapshot.contextThreadId}`
              : ""
        }${targetSnapshot.available === false ? " (unavailable)" : ""}`;
  // Derived from typed runtime state, not feedback wording: visible only while
  // a submission is dispatched and unanswered. No animation, so reduced motion
  // needs no special case.
  const waitingView = buildCirceVoiceWaitingView({
    busy: commandBusy,
    awaitingAnswer,
    feedbackKind: feedback?.kind ?? null,
    feedbackText: feedback?.text ?? null,
    targetLabel,
    targetAvailable: targetSnapshot?.available ?? false,
  });
  const activeTask = tasks.find((task) => task.threadId === targetSnapshot?.contextThreadId);
  const presenceMode = circePresenceMode({
    listening: liveVoice.active && liveVoice.status === "live",
    submitting: commandBusy,
    activeTaskState: activeTask?.state ?? null,
    error: feedback?.kind === "error" ? feedback.text : null,
  });

  const orbState: CirceOrbState =
    presenceMode === "listening" || presenceMode === "speaking"
      ? "listening"
      : presenceMode === "working"
        ? "working"
        : presenceMode === "attention"
          ? "attention"
          : presenceMode === "error"
            ? "error"
            : "idle";
  const presenceLabel = {
    idle: "Ready",
    listening: "Listening",
    working: "Working",
    speaking: "Speaking",
    attention: "Needs you",
    error: "Needs attention",
  }[presenceMode];

  return (
    <section aria-label="Circe command" className="circe-console min-w-0">
      <div className="circe-hero">
        <div className="circe-hero__presence">
          <CirceOrb state={orbState} size="xl" />
          <div className="min-w-0">
            <p className="circe-presence-label" data-state={presenceMode} aria-live="polite">
              <span aria-hidden />
              {presenceLabel}
            </p>
            <h2 className="circe-hero__title">{greetingForHour(new Date().getHours())}</h2>
            <p className="circe-hero__subtitle">
              Tell Circe what you want done. It finds the right machine and project.
            </p>
          </div>
        </div>

        <div className="circe-composer-frame">
          <textarea
            aria-label="Circe instruction"
            className="circe-composer w-full"
            placeholder={
              awaitingAnswer ? "Answer Circe…" : "Fix the failing billing tests on my laptop…"
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                sendDraft();
              }
            }}
          />
          <div className="circe-composer-footer">
            <div className="circe-command-fields">
              <label className="circe-chip" data-selected={Boolean(targetSnapshot?.projectRef)}>
                <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="circe-field-label">Project</span>
                <select
                  id="circe-target-project"
                  aria-label="Circe project target"
                  className="circe-select"
                  disabled={commandPending}
                  value={
                    targetSnapshot?.projectRef
                      ? `${targetSnapshot.projectRef.nodeId}:${targetSnapshot.projectRef.projectId}`
                      : ""
                  }
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "") {
                      requestCirceTarget({ type: "clear" });
                      return;
                    }
                    const project = projects.find(
                      (candidate) => `${candidate.ref.nodeId}:${candidate.ref.projectId}` === value,
                    );
                    if (project) {
                      requestCirceTarget({
                        type: "select-project",
                        projectRef: project.ref,
                        projectTitle: project.title,
                        nodeLabel: project.nodeLabel,
                      });
                    }
                  }}
                >
                  <option value="">Anywhere</option>
                  {projects.map((project) => (
                    <option
                      key={`${project.ref.nodeId}:${project.ref.projectId}`}
                      value={`${project.ref.nodeId}:${project.ref.projectId}`}
                    >
                      {project.title} — {project.nodeLabel}
                    </option>
                  ))}
                </select>
              </label>
              {tasks.length > 0 ? (
                <label
                  className="circe-chip"
                  data-selected={Boolean(targetSnapshot?.contextThreadId)}
                >
                  <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="circe-field-label">Task context</span>
                  <select
                    id="circe-target-task"
                    aria-label="Circe task target"
                    className="circe-select"
                    disabled={commandPending}
                    value={targetSnapshot?.contextThreadId ?? ""}
                    onChange={(event) => {
                      const threadId = event.target.value;
                      if (threadId === "") return;
                      const task = tasks.find((candidate) => candidate.threadId === threadId);
                      if (task === undefined) return;
                      requestCirceTarget({
                        type: "select-task",
                        projectRef: task.projectRef,
                        threadId: task.threadId,
                        title: task.title,
                        ...(task.taskRef === undefined ? {} : { taskRef: task.taskRef }),
                        ...(task.pendingReply === undefined
                          ? {}
                          : { pendingReply: task.pendingReply }),
                      });
                    }}
                  >
                    <option value="">Current task</option>
                    {tasks.map((task) => (
                      <option key={task.threadId} value={task.threadId}>
                        {task.title}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {targetSnapshot?.projectRef ? (
                <button
                  type="button"
                  className="circe-chip-clear"
                  aria-label="Clear target"
                  disabled={commandPending}
                  onClick={() => requestCirceTarget({ type: "clear" })}
                >
                  <XIcon className="size-3.5" />
                </button>
              ) : null}
            </div>
            <div className="circe-composer-actions">
              {canRetry ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => requestCirceCommandAction({ type: "retry", inputMode: "text" })}
                >
                  Retry
                </Button>
              ) : null}
              {commandPending || canRetry || draft.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={cancelPending}>
                  Cancel
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                className="circe-voice-button"
                aria-pressed={liveVoice.active}
                disabled={!liveVoice.active && catalog === null}
                onClick={() => setCirceLiveVoiceActive(!liveVoice.active)}
              >
                <MicIcon className="size-3.5" />
                {liveVoice.active
                  ? liveVoice.status === "live"
                    ? "End conversation"
                    : liveVoice.status === "closing"
                      ? "Ending…"
                      : "Connecting…"
                  : "Voice"}
              </Button>
              <Button
                className="circe-send-button"
                size="icon-sm"
                aria-label={commandBusy ? "Working" : awaitingAnswer ? "Send answer" : "Send"}
                title="Send instruction (Ctrl or Command + Enter)"
                disabled={sendDisabled}
                onClick={sendDraft}
              >
                <ArrowUpIcon className="size-4" />
              </Button>
            </div>
          </div>
        </div>
        <p className="circe-target-context" aria-live="polite">
          {targetSnapshot?.projectRef
            ? `Working in ${targetLabel}`
            : "No target chosen. Circe picks the project from what you say, and asks when it is not sure."}
        </p>
        {liveVoice.active ? (
          <p className="circe-inline-note" aria-live="polite">
            Live conversation owns the microphone. End it to type.
          </p>
        ) : null}
        {waitingView ? (
          <div aria-live="polite" className="circe-feedback circe-feedback-waiting">
            <ActivityIcon className="size-4 shrink-0" />
            <div>
              <p className="text-xs font-medium text-foreground">{waitingView.targetNote}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {waitingView.correctionHint}
              </p>
            </div>
          </div>
        ) : null}
        {feedback ? (
          <p
            aria-live="polite"
            className={cn("circe-feedback", feedback.kind === "error" && "circe-feedback-error")}
          >
            <span className="circe-feedback-label">Circe</span>
            {feedback.text}
          </p>
        ) : null}
      </div>

      <div className="circe-board">
        <header className="circe-board__header">
          <h3>Work</h3>
          <div className="circe-agent-tabs" aria-label="Task views">
            <button
              type="button"
              aria-pressed={activityView === "recent"}
              onClick={() => setActivityView("recent")}
            >
              Recent tasks
            </button>
            <button
              type="button"
              aria-pressed={activityView === "active"}
              onClick={() => setActivityView("active")}
            >
              Running agents
            </button>
          </div>
        </header>
        <CirceLiveAgents catalog={catalog} view={activityView} />
      </div>
    </section>
  );
}

/** Plain time-of-day greeting for the command center hero. */
export function greetingForHour(hour: number): string {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function CirceControlCenter() {
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const refreshMesh = useAtomCommand(circeMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const [catalog, setCatalog] = useState<CirceMeshCatalog | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<EnvironmentId | null>(primaryEnvironmentId);
  const refreshGeneration = useRef(0);
  const connectionKey = JSON.stringify(
    environments.map((environment) => [environment.environmentId, environment.connection.phase]),
  );
  const registeredNodes = useMemo(
    () =>
      environments.map((environment): CirceMeshNode => ({
        nodeId: environment.environmentId,
        label: environment.serverConfig?.environment.label ?? environment.label,
        reachability: environment.connection.phase === "connected" ? "online" : "offline",
        ...(environment.serverConfig?.environment.capabilities.circeNode === undefined
          ? {}
          : { capabilities: environment.serverConfig.environment.capabilities.circeNode }),
        ...(environment.connection.error === null
          ? {}
          : { catalogError: environment.connection.error }),
      })),
    [environments],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setPending(true);
    setError(null);
    const result = await refreshMesh(undefined);
    if (generation !== refreshGeneration.current) return;
    if (result._tag === "Failure") {
      setError(circeErrorMessage(squashAtomCommandFailure(result)));
    } else {
      setCatalog(result.value);
    }
    setPending(false);
  }, [refreshMesh]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh, connectionKey]);
  const view = useMemo(
    () =>
      buildCirceControlCenterView(catalog ?? EMPTY_CATALOG, {
        registeredNodes,
        currentNodeId: isElectron ? primaryEnvironmentId : null,
      }),
    [catalog, registeredNodes, primaryEnvironmentId],
  );
  const selectedDevice = useMemo(
    () =>
      view.devices.find((device) => device.node.nodeId === selectedNodeId) ??
      view.devices[0] ??
      null,
    [selectedNodeId, view.devices],
  );

  const liveCatalog = useMemo(
    () =>
      catalog === null
        ? null
        : {
            ...catalog,
            nodes: registeredNodes,
          },
    [catalog, registeredNodes],
  );

  return (
    <SidebarInset className="circe-control-center h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Circe environment breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <span className="flex items-center gap-2">
                <img src={CIRCE_MARK_SRC} alt="" className="size-4" />
                <h1 className="text-sm font-semibold tracking-tight">Command center</h1>
              </span>
            </WorkspaceBreadcrumbItem>
            {selectedDevice ? (
              <>
                <WorkspaceBreadcrumbSeparator className="hidden sm:flex" />
                <WorkspaceBreadcrumbItem className="hidden min-w-0 shrink sm:flex">
                  <span className="truncate">{selectedDevice.node.label}</span>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
          <div className="ms-auto flex items-center gap-3">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              <Settings2Icon /> Connections
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh Circe environment"
              disabled={pending}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon
                className={cn("size-3.5", pending && "animate-spin motion-reduce:animate-none")}
              />
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="circe-page">
            {error ? (
              <div className="circe-alert flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/8 px-3 py-2.5 text-xs text-destructive-foreground">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {error}
              </div>
            ) : null}

            {pending && catalog === null && view.devices.length === 0 ? (
              <div className="circe-empty-state" role="status">
                <CirceOrb state="working" size="lg" />
                <p>Finding your machines…</p>
              </div>
            ) : view.devices.length === 0 ? (
              <div className="circe-empty-state">
                <CirceOrb size="lg" />
                <h2>No machines connected</h2>
                <p>Pair or reconnect a machine in Connections, and it appears here.</p>
                <Button size="sm" onClick={() => void navigate({ to: "/settings/connections" })}>
                  Open Connections
                </Button>
              </div>
            ) : selectedDevice ? (
              <div className="circe-command-layout">
                <main className="min-w-0">
                  <CirceCommandConsole catalog={liveCatalog} />
                </main>
                <aside className="circe-side-rail">
                  <DeviceConstellation
                    devices={view.devices}
                    selectedNodeId={selectedDevice.node.nodeId}
                    onSelect={setSelectedNodeId}
                    summary={view.summary}
                  />
                  <div className="circe-rail-card">
                    <DeviceHero device={selectedDevice} />
                    <CirceComputerSection
                      key={selectedDevice.node.nodeId}
                      environmentId={selectedDevice.node.nodeId}
                      online={selectedDevice.node.reachability === "online"}
                    />
                    <ProviderSection
                      providers={selectedDevice.providers}
                      onManage={() =>
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: selectedDevice.node.nodeId },
                        })
                      }
                    />
                    <ProjectSection
                      projects={selectedDevice.projects.filter(
                        (project) => !isChatWorkspace(project),
                      )}
                    />
                    <CirceNodeAgentSettings
                      key={selectedDevice.node.nodeId}
                      environmentId={selectedDevice.node.nodeId}
                      online={selectedDevice.node.reachability === "online"}
                      executionEnabled={selectedDevice.node.capabilities?.execution === true}
                    />
                  </div>
                  <CirceMeshDevices />
                </aside>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
