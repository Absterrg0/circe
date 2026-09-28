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
  AtSignIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FolderGit2Icon,
  ListTodoIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  SquarePenIcon,
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
import { openCommandPalette } from "../../commandPaletteBus";
import { cn, randomUUID } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { circeMeshEnvironment } from "../../state/circeMesh";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  getCirceLiveVoiceUiState,
  subscribeCirceLiveVoice,
  toggleCirceLiveVoiceFromUser,
} from "./CirceLiveVoice.bridge";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  buildCirceControlCenterView,
  type CirceControlCenterDevice,
  type CirceControlCenterView,
} from "./CirceControlCenter.logic";
import { circeErrorMessage } from "./CirceManager.logic";
import { buildCirceVoiceWaitingView } from "@circe/client-runtime/circe/voiceWaiting";
import { CirceLiveAgents, type CirceActivityFilter } from "./CirceLiveAgents";
import { CirceMeshDevices } from "./CirceMeshDevices";
import { CirceComputerSection } from "./CirceComputerSection";
import { CirceNodeAgentSettings } from "./CirceNodeAgentSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { circePresenceMode } from "./CircePresence.logic";
import {
  greetingForHour,
  overviewAttentionLine,
  summarizeCirceOverview,
} from "./CirceOverview.logic";
import { ProviderMark } from "./ui/ProviderMark";
import { Presence, StatusGlyph } from "./ui/StatusGlyph";
import "./ui/circe-ui.css";
import "./CirceControlCenter.css";

export { greetingForHour } from "./CirceOverview.logic";

const EMPTY_CATALOG: CirceMeshCatalog = { nodes: [], projects: [], providers: [] };

function StatusDot({ online }: { readonly online: boolean }) {
  return <Presence state={online ? "online" : "offline"} ring="var(--canvas)" />;
}

/** Full, Controller or Headless, as the user-facing preset name. */
function presetLabel(preset: string | undefined): string {
  if (!preset) return "Unknown preset";
  return preset.charAt(0).toUpperCase() + preset.slice(1);
}

function relativeTime(iso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (Number.isNaN(elapsed)) return "";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The machine list. Selecting a machine scopes the details below it: its
 * computer, providers, projects and Circe settings.
 */
function MachineList({
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
  const navigate = useNavigate();
  const threads = useThreadShells();
  const workByNode = useMemo(() => {
    const work = new Map<string, { needs: number; running: number }>();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const entry = work.get(thread.environmentId) ?? { needs: 0, running: 0 };
      if (thread.hasPendingApprovals || thread.hasPendingUserInput) entry.needs += 1;
      else if (
        thread.runtime !== null &&
        ["preparing", "queued", "starting", "running"].includes(thread.runtime.status)
      )
        entry.running += 1;
      work.set(thread.environmentId, entry);
    }
    return work;
  }, [threads]);
  const offline = devices.filter((device) => device.node.reachability !== "online");
  return (
    <section aria-label="Your machines">
      <div className="ov-head">
        <h2 className="ov-h">Machines</h2>
        <span className="ov-count text-ink-faint">
          {summary.onlineDevices}/{summary.devices}
        </span>
        <span className="ov-filters">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void navigate({ to: "/settings/connections" })}
          >
            <PlusIcon /> Pair
          </Button>
        </span>
      </div>
      <div role="list">
        {devices.map((device) => {
          const online = device.node.reachability === "online";
          const selected = device.node.nodeId === selectedNodeId;
          const work = workByNode.get(device.node.nodeId);
          const preset = device.node.capabilities?.preset ?? null;
          return (
            <button
              key={device.node.nodeId}
              type="button"
              role="listitem"
              aria-pressed={selected}
              className="ci-noderow"
              data-selected={selected ? "true" : "false"}
              data-online={online ? "true" : "false"}
              onClick={() => onSelect(device.node.nodeId)}
            >
              <span className="ci-noderow__tile">
                {device.node.capabilities?.ui === false ? (
                  <ServerIcon className="size-4" strokeWidth={1.5} />
                ) : (
                  <MonitorIcon className="size-4" strokeWidth={1.5} />
                )}
                <Presence
                  state={!online ? "offline" : work && work.running > 0 ? "busy" : "online"}
                  ring="var(--canvas)"
                />
              </span>
              <span className="ci-noderow__id">
                <span className="ci-noderow__name">
                  {device.node.label.toLowerCase()}
                  {device.isCurrentDevice ? (
                    <span className="ci-noderow__you">this machine</span>
                  ) : null}
                </span>
                <span className="ci-noderow__meta">
                  {preset ? presetLabel(preset) : "Node"}
                  {device.isCurrentDevice ? " · Local" : ""}
                </span>
              </span>
              <span className="ci-noderow__detail" data-offline={online ? "false" : "true"}>
                {!online
                  ? "offline"
                  : work && work.needs > 0
                    ? `${work.needs} need${work.needs === 1 ? "s" : ""} you`
                    : work && work.running > 0
                      ? `${work.running} running`
                      : "idle"}
              </span>
            </button>
          );
        })}
      </div>
      {offline.length > 0 ? (
        <p className="ov-note">
          <WifiOffIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {offline.length === 1
            ? `${offline[0]!.node.label.toLowerCase()} is offline. Its tasks stay there until it is back; Circe will not move them.`
            : `${offline.length} machines are offline. Their tasks stay where they are; Circe will not move them.`}
        </p>
      ) : null}
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
          {device.isCurrentDevice ? "This machine" : "Paired machine"}
          <span aria-hidden> · </span>
          {presetLabel(device.node.capabilities?.preset)}
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

  const presenceLabel = {
    idle: "Ready",
    listening: "Listening",
    working: "Working",
    speaking: "Speaking",
    attention: "Needs you",
    error: "Needs attention",
  }[presenceMode];

  return (
    <section aria-label="Circe command" className="ov-console min-w-0">
      <div
        className={cn("ci-composer", liveVoice.active && "is-listening")}
        data-presence={presenceMode}
      >
        {presenceMode !== "idle" ? (
          <p className="ov-presence" data-state={presenceMode} aria-live="polite">
            <span className="ci-label">{presenceLabel}</span>
          </p>
        ) : null}
        <textarea
          aria-label="Circe instruction"
          className="ci-composer__input"
          rows={2}
          placeholder={awaitingAnswer ? "Answer Circe…" : "Tell Circe what to do, on any machine…"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              sendDraft();
            }
          }}
        />
        <div className="ci-composer__bar">
          <label
            className="ci-chip ci-chip--select"
            data-selected={Boolean(targetSnapshot?.projectRef)}
          >
            <AtSignIcon aria-hidden className="size-3.5 shrink-0" />
            <select
              id="circe-target-project"
              aria-label="Circe project target"
              className="ci-chip__select"
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
              <option value="">Auto</option>
              {projects.map((project) => (
                <option
                  key={`${project.ref.nodeId}:${project.ref.projectId}`}
                  value={`${project.ref.nodeId}:${project.ref.projectId}`}
                >
                  {project.title} on {project.nodeLabel.toLowerCase()}
                </option>
              ))}
            </select>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
          </label>
          {tasks.length > 0 ? (
            <label
              className="ci-chip ci-chip--select"
              data-selected={Boolean(targetSnapshot?.contextThreadId)}
            >
              <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
              <select
                id="circe-target-task"
                aria-label="Circe task target"
                className="ci-chip__select"
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
                    ...(task.pendingReply === undefined ? {} : { pendingReply: task.pendingReply }),
                  });
                }}
              >
                <option value="">Any task</option>
                {tasks.map((task) => (
                  <option key={task.threadId} value={task.threadId}>
                    {task.title}
                  </option>
                ))}
              </select>
              <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
            </label>
          ) : null}
          {targetSnapshot?.projectRef ? (
            <button
              type="button"
              className="ci-chip"
              aria-label="Clear target"
              disabled={commandPending}
              onClick={() => requestCirceTarget({ type: "clear" })}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
          <span className="ci-composer__spacer" />
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
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="ov-voice"
                  aria-label={
                    liveVoice.active
                      ? liveVoice.status === "live"
                        ? "End conversation"
                        : liveVoice.status === "closing"
                          ? "Ending…"
                          : "Connecting…"
                      : "Talk to Circe"
                  }
                  aria-pressed={liveVoice.active}
                  data-active={liveVoice.active ? "true" : "false"}
                  disabled={!liveVoice.active && catalog === null}
                  onClick={toggleCirceLiveVoiceFromUser}
                />
              }
            >
              <MicIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {liveVoice.active ? "End conversation" : "Talk to Circe"}
            </TooltipPopup>
          </Tooltip>
          <Button
            className="ov-send"
            data-ready={sendDisabled ? "false" : "true"}
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
      <p className="ov-target" aria-live="polite">
        {targetSnapshot?.projectRef
          ? `Working in ${targetLabel}`
          : "Circe picks the project and machine from what you say, and asks when it is not sure."}
      </p>
      {liveVoice.active ? (
        <p className="ov-target" aria-live="polite">
          The live conversation has the microphone. End it to type.
        </p>
      ) : null}
      {waitingView ? (
        <div aria-live="polite" className="ov-feedback" data-tone="waiting">
          <StatusGlyph state="running" size={14} />
          <div>
            <p className="ov-feedback__title">{waitingView.targetNote}</p>
            <p className="ov-feedback__hint">{waitingView.correctionHint}</p>
          </div>
        </div>
      ) : null}
      {feedback ? (
        <p
          aria-live="polite"
          className="ov-feedback"
          data-tone={feedback.kind === "error" ? "error" : "info"}
        >
          <span className="ci-label">Circe</span>
          <span>{feedback.text}</span>
        </p>
      ) : null}
    </section>
  );
}

/** "Good evening. Two tasks need you." and the numbers behind it. */
function OverviewHeadline({
  onlineDevices,
  devices,
}: {
  readonly onlineDevices: number;
  readonly devices: number;
}) {
  const threads = useThreadShells();
  const summary = useMemo(() => summarizeCirceOverview(threads, new Date()), [threads]);
  const attention = overviewAttentionLine(summary.needs.length, summary.running);
  return (
    <div className="ov-top">
      <h1 className="ov-title">
        {greetingForHour(new Date().getHours())}.{" "}
        <span className="ov-title__second" data-tone={attention.tone}>
          {attention.text}
        </span>
      </h1>
      <dl className="ov-stats">
        <div className="ov-stat">
          <dd className="ov-stat__value" data-tone={summary.running > 0 ? "ember" : undefined}>
            {summary.running}
          </dd>
          <dt className="ov-stat__label">Running</dt>
        </div>
        <div className="ov-stat">
          <dd className="ov-stat__value">{summary.completedToday}</dd>
          <dt className="ov-stat__label">Completed today</dt>
        </div>
        {summary.failed > 0 ? (
          <div className="ov-stat">
            <dd className="ov-stat__value" data-tone="danger">
              {summary.failed}
            </dd>
            <dt className="ov-stat__label">Failed</dt>
          </div>
        ) : null}
        <div className="ov-stat">
          <dd className="ov-stat__value">
            {onlineDevices}/{devices}
          </dd>
          <dt className="ov-stat__label">Machines online</dt>
        </div>
      </dl>
    </div>
  );
}

/**
 * Work waiting on the user. The first row glows: if two things glow gold,
 * one of them is wrong. Approvals and answers happen in the task, where the
 * full command is readable.
 */
function OverviewNeeds({ catalog }: { readonly catalog: CirceMeshCatalog | null }) {
  const threads = useThreadShells();
  const navigate = useNavigate();
  const { needs, now } = useMemo(() => {
    const at = new Date();
    return { needs: summarizeCirceOverview(threads, at).needs, now: at.getTime() };
  }, [threads]);
  if (needs.length === 0) return null;
  return (
    <section aria-label="Needs you">
      <div className="ov-head">
        <h2 className="ov-h">Needs you</h2>
        <span className="ov-count text-attention">{needs.length}</span>
      </div>
      <div className="ov-needs">
        {needs.map((thread, index) => {
          const project = catalog?.projects.find(
            (candidate) =>
              candidate.ref.nodeId === thread.environmentId &&
              candidate.ref.projectId === thread.projectId,
          );
          const node = catalog?.nodes.find(
            (candidate) => candidate.nodeId === thread.environmentId,
          );
          const provider =
            catalog?.providers.find(
              (candidate) =>
                candidate.nodeId === thread.environmentId &&
                candidate.snapshot.instanceId === thread.modelSelection.instanceId,
            )?.snapshot.displayName ??
            thread.runtime?.providerName ??
            String(thread.modelSelection.instanceId);
          const open = () =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: thread.environmentId, threadId: thread.id },
            });
          return (
            <div
              key={`${thread.environmentId}:${thread.id}`}
              className="ci-needs"
              data-first={index === 0 ? "true" : "false"}
              role="group"
              aria-label={thread.title}
            >
              <span className="ci-needs__glyph">
                <StatusGlyph state="needs" size={14} />
              </span>
              <div className="ci-needs__body">
                <div className="ci-needs__top">
                  <span className="ci-needs__title">{thread.title}</span>
                  <span className="ci-needs__where">
                    {project ? <span>{project.title}</span> : null}
                    {node ? (
                      <span className="inline-flex items-center gap-0.5">
                        <AtSignIcon aria-hidden className="size-3" />
                        {node.label.toLowerCase()}
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="ci-needs__detail">
                  <ProviderMark name={provider} />
                  <span>
                    {thread.hasPendingApprovals
                      ? "wants your approval to continue"
                      : "asked you a question"}
                  </span>
                  <span className="ci-needs__time">{relativeTime(thread.updatedAt, now)}</span>
                </div>
              </div>
              <div className="ci-needs__actions">
                <Button size="sm" variant={index === 0 ? "default" : "outline"} onClick={open}>
                  {thread.hasPendingApprovals ? "Review" : "Answer…"}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OverviewActivity({ catalog }: { readonly catalog: CirceMeshCatalog | null }) {
  const [filter, setFilter] = useState<CirceActivityFilter>("all");
  const options: ReadonlyArray<{ value: CirceActivityFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "running", label: "Running" },
    { value: "failed", label: "Failed" },
  ];
  return (
    <section aria-label="Activity">
      <div className="ov-head">
        <h2 className="ov-h">Activity</h2>
        <span className="ov-filters" role="tablist" aria-label="Activity filter">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </span>
      </div>
      <CirceLiveAgents catalog={catalog} filter={filter} />
    </section>
  );
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

  const now = new Date();
  const dateLabel = `${now.toLocaleDateString([], { weekday: "long" })}, ${now.toLocaleTimeString(
    [],
    {
      hour: "numeric",
      minute: "2-digit",
    },
  )}`;

  return (
    <SidebarInset className="circe-control-center h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 items-baseline gap-3.5">
            <h1 className="text-sm font-semibold text-foreground">Overview</h1>
            <span className="hidden truncate text-[12.5px] text-ink-faint sm:inline">
              {dateLabel}
            </span>
          </div>
          <div className="ms-auto flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh machines"
              disabled={pending}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon
                className={cn("size-3.5", pending && "animate-spin motion-reduce:animate-none")}
              />
            </Button>
            <Button size="sm" onClick={() => openCommandPalette({ open: "new-thread-in" })}>
              <SquarePenIcon /> New task
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          {error ? (
            <div className="ov-alert">
              <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" /> {error}
            </div>
          ) : null}
          {pending && catalog === null && view.devices.length === 0 ? (
            <div className="ov-empty-state" role="status">
              <StatusGlyph state="running" size={18} />
              <p>Finding your machines…</p>
            </div>
          ) : view.devices.length === 0 ? (
            <div className="ov-empty-state">
              <h2>No machines connected</h2>
              <p>Pair or reconnect a machine in Connections, and it appears here.</p>
              <Button size="sm" onClick={() => void navigate({ to: "/settings/connections" })}>
                Open Connections
              </Button>
            </div>
          ) : selectedDevice ? (
            <div className="ov">
              <main className="ov-main">
                <section className="ov-top-wrap">
                  <OverviewHeadline
                    onlineDevices={view.summary.onlineDevices}
                    devices={view.summary.devices}
                  />
                  <CirceCommandConsole catalog={liveCatalog} />
                </section>
                <OverviewNeeds catalog={liveCatalog} />
                <OverviewActivity catalog={liveCatalog} />
              </main>
              <aside className="ov-side">
                <MachineList
                  devices={view.devices}
                  selectedNodeId={selectedDevice.node.nodeId}
                  onSelect={setSelectedNodeId}
                  summary={view.summary}
                />
                <section className="ov-machine" aria-label={`${selectedDevice.node.label} details`}>
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
                    key={`settings:${selectedDevice.node.nodeId}`}
                    environmentId={selectedDevice.node.nodeId}
                    online={selectedDevice.node.reachability === "online"}
                    executionEnabled={selectedDevice.node.capabilities?.execution === true}
                  />
                </section>
                <CirceMeshDevices />
              </aside>
            </div>
          ) : null}
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
