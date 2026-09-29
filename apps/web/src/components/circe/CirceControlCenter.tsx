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
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "../ui/sheet";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  buildCirceControlCenterView,
  type CirceControlCenterDevice,
} from "./CirceControlCenter.logic";
import { circeErrorMessage } from "./CirceManager.logic";
import { buildCirceVoiceWaitingView } from "@circe/client-runtime/circe/voiceWaiting";
import { CirceLiveAgents, type CirceActivityFilter } from "./CirceLiveAgents";
import { CirceMeshDevices } from "./CirceMeshDevices";
import { CirceComputerSection } from "./CirceComputerSection";
import { CirceNodeAgentSettings } from "./CirceNodeAgentSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { circePresenceMode } from "./CircePresence.logic";
import { CIRCE_RAIL_MARK_SRC } from "./CirceBrand";
import {
  greetingForHour,
  overviewAttentionLine,
  overviewTaskState,
  summarizeCirceOverview,
} from "./CirceOverview.logic";
import { ProviderMark } from "./ui/ProviderMark";
import { Presence, StatusGlyph } from "./ui/StatusGlyph";
import "./ui/circe-ui.css";
import "./CirceControlCenter.css";

export { greetingForHour } from "./CirceOverview.logic";

const EMPTY_CATALOG: CirceMeshCatalog = { nodes: [], projects: [], providers: [] };

/** Full, Controller or Headless, as the user-facing preset name. */
function presetLabel(preset: string | undefined): string {
  if (!preset) return "Node";
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

interface NodeWork {
  readonly needs: number;
  readonly running: number;
}

function useWorkByNode(): ReadonlyMap<string, NodeWork> {
  const threads = useThreadShells();
  return useMemo(() => {
    const work = new Map<string, { needs: number; running: number }>();
    for (const thread of threads) {
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      const state = overviewTaskState(thread);
      if (state !== "needs" && state !== "running") continue;
      const entry = work.get(thread.environmentId) ?? { needs: 0, running: 0 };
      if (state === "needs") entry.needs += 1;
      else entry.running += 1;
      work.set(thread.environmentId, entry);
    }
    return work;
  }, [threads]);
}

const MAX_TICKS = 8;

/** One tick per live task: gold for needs you, copper for running. */
function WorkTicks({ work }: { readonly work: NodeWork }) {
  const needs = Math.min(work.needs, MAX_TICKS);
  const running = Math.min(work.running, MAX_TICKS - needs);
  if (needs + running === 0) return null;
  return (
    <span className="home-plate__ticks" aria-hidden>
      {Array.from({ length: needs }, (_, index) => (
        <i key={`n${index}`} data-tone="needs" />
      ))}
      {Array.from({ length: running }, (_, index) => (
        <i key={`r${index}`} data-tone="running" />
      ))}
    </span>
  );
}

function workLine(online: boolean, work: NodeWork | undefined): string {
  if (!online) return "Offline. Its tasks stay there.";
  if (!work || work.needs + work.running === 0) return "Idle";
  const parts: string[] = [];
  if (work.needs > 0) parts.push(`${work.needs} need${work.needs === 1 ? "s" : ""} you`);
  if (work.running > 0) parts.push(`${work.running} running`);
  return parts.join(", ");
}

function MachineIcon({ device }: { readonly device: CirceControlCenterDevice }) {
  return device.node.capabilities?.ui === false ? (
    <ServerIcon strokeWidth={1.5} />
  ) : (
    <MonitorIcon strokeWidth={1.5} />
  );
}

/**
 * Every machine as a plate: where it is, what it runs as, and the live work
 * on it. Opening a plate shows that machine's setup; it never scopes or
 * navigates anything else.
 */
function MachinePlates({
  devices,
  selectedNodeId,
  onSelect,
}: {
  readonly devices: ReadonlyArray<CirceControlCenterDevice>;
  readonly selectedNodeId: EnvironmentId | null;
  readonly onSelect: (nodeId: EnvironmentId) => void;
}) {
  const workByNode = useWorkByNode();
  return (
    <div className="home-plates" role="list">
      {devices.map((device) => {
        const online = device.node.reachability === "online";
        const work = workByNode.get(device.node.nodeId);
        const preset = device.node.capabilities?.preset;
        return (
          <button
            key={device.node.nodeId}
            type="button"
            role="listitem"
            className="home-plate"
            aria-haspopup="dialog"
            data-selected={device.node.nodeId === selectedNodeId ? "true" : "false"}
            data-online={online ? "true" : "false"}
            onClick={() => onSelect(device.node.nodeId)}
          >
            <span className="home-plate__top">
              <span className="home-plate__tile">
                <MachineIcon device={device} />
                <Presence
                  state={!online ? "offline" : work && work.running > 0 ? "busy" : "online"}
                  ring="var(--canvas)"
                />
              </span>
              <span className="home-plate__id">
                <span className="home-plate__name">{device.node.label.toLowerCase()}</span>
                <span className="home-plate__meta">
                  {presetLabel(preset)} node
                  {device.isCurrentDevice ? ", this machine" : ""}
                </span>
              </span>
            </span>
            <span className="home-plate__work" data-offline={online ? "false" : "true"}>
              {online && work ? <WorkTicks work={work} /> : null}
              <span>{workLine(online, work)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MachineHeader({ device }: { readonly device: CirceControlCenterDevice }) {
  const online = device.node.reachability === "online";
  return (
    <header className="home-sheet__head">
      <span className="home-plate__tile home-plate__tile--lg">
        <MachineIcon device={device} />
        <Presence state={online ? "online" : "offline"} ring="var(--overlay)" />
      </span>
      <div className="min-w-0 flex-1">
        <SheetTitle className="home-sheet__title">{device.node.label.toLowerCase()}</SheetTitle>
        <SheetDescription className="home-sheet__sub">
          {presetLabel(device.node.capabilities?.preset)} node
          {device.isCurrentDevice ? " on this machine" : ""}, {online ? "online" : "offline"}
        </SheetDescription>
      </div>
      {device.node.catalogError ? (
        <p className="home-sheet__error">
          <WifiOffIcon className="size-3.5 shrink-0" />
          {device.node.catalogError}
        </p>
      ) : null}
    </header>
  );
}

function ProviderSection({
  providers,
  onManage,
}: {
  readonly providers: CirceControlCenterDevice["providers"];
  readonly onManage: () => void;
}) {
  const ready = providers.filter((provider) => provider.available).length;
  return (
    <section className="home-sheet__section">
      <div className="home-sheet__section-head">
        <h3>Providers</h3>
        <span className="home-count">
          {ready} of {providers.length} ready
        </span>
        <button type="button" onClick={onManage} className="home-link">
          Manage
        </button>
      </div>
      {providers.length === 0 ? (
        <p className="home-note">Connect a provider to start working.</p>
      ) : (
        <ul className="home-sheet__list">
          {providers.map((provider) => (
            <li key={provider.snapshot.instanceId} data-dim={provider.available ? "false" : "true"}>
              <ProviderInstanceIcon
                driverKind={provider.snapshot.driver}
                displayName={provider.snapshot.displayName ?? provider.snapshot.driver}
                iconClassName="size-4"
              />
              <span className="home-sheet__list-name">
                {provider.snapshot.displayName ?? provider.snapshot.driver}
              </span>
              <span className="home-sheet__list-state" data-ready={provider.available}>
                {provider.available
                  ? "Ready"
                  : !provider.snapshot.enabled
                    ? "Disabled"
                    : "Needs setup"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProjectSection({ projects }: { readonly projects: CirceControlCenterDevice["projects"] }) {
  return (
    <section className="home-sheet__section">
      <div className="home-sheet__section-head">
        <h3>Projects</h3>
        <span className="home-count">{projects.length}</span>
      </div>
      {projects.length === 0 ? (
        <p className="home-note">No projects on this machine yet.</p>
      ) : (
        <ul className="home-sheet__list">
          {projects.map((project) => (
            <li key={project.ref.projectId}>
              <FolderGit2Icon className="size-4 shrink-0 text-ink-faint" strokeWidth={1.5} />
              <span className="home-sheet__list-name">{project.title}</span>
              <Tooltip>
                <TooltipTrigger render={<span className="home-sheet__path" tabIndex={0} />}>
                  {project.workspaceRoot}
                </TooltipTrigger>
                <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </section>
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
            <StatusGlyph
              state={
                presenceMode === "attention"
                  ? "needs"
                  : presenceMode === "error"
                    ? "failed"
                    : presenceMode === "speaking" || presenceMode === "listening"
                      ? "speaking"
                      : "running"
              }
              size={12}
            />
            {presenceLabel}
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
          <img alt="" src={CIRCE_RAIL_MARK_SRC} className="ov-feedback__mark" />
          <span>{feedback.text}</span>
        </p>
      ) : null}
    </section>
  );
}

/** "Good evening." and one plain sentence about the state of the work. */
function HomeHeadline() {
  const threads = useThreadShells();
  const summary = useMemo(() => summarizeCirceOverview(threads, new Date()), [threads]);
  const attention = overviewAttentionLine(summary.needs.length, summary.running);
  const extra = [
    summary.completedToday > 0 ? `${summary.completedToday} finished today.` : null,
    summary.failed > 0 ? `${summary.failed} failed.` : null,
  ].filter((part) => part !== null);
  return (
    <div className="home-hello">
      <h1 className="home-hello__greeting">{greetingForHour(new Date().getHours())}.</h1>
      <p className="home-hello__state" data-tone={attention.tone}>
        {attention.tone === "attention" ? (
          <StatusGlyph state="needs" size={14} />
        ) : attention.tone === "ember" ? (
          <StatusGlyph state="running" size={14} />
        ) : null}
        <span>
          <span className="home-hello__lead">{attention.text}</span>
          {extra.length > 0 ? ` ${extra.join(" ")}` : null}
        </span>
      </p>
    </div>
  );
}

function SectionHead({
  title,
  count,
  tone,
  children,
}: {
  readonly title: string;
  readonly count?: number | string | undefined;
  readonly tone?: "attention";
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="home-head">
      <h2>{title}</h2>
      {count !== undefined ? (
        <span className="home-count" data-tone={tone}>
          {count}
        </span>
      ) : null}
      {children ? <div className="home-head__end">{children}</div> : null}
    </div>
  );
}

/**
 * Work waiting on the user. Approvals and answers happen in the task, where
 * the full command is readable, so each row opens it.
 */
function HomeNeeds({ catalog }: { readonly catalog: CirceMeshCatalog | null }) {
  const threads = useThreadShells();
  const navigate = useNavigate();
  const { needs, now } = useMemo(() => {
    const at = new Date();
    return { needs: summarizeCirceOverview(threads, at).needs, now: at.getTime() };
  }, [threads]);
  if (needs.length === 0) return null;
  return (
    <section aria-label="Needs you" className="home-section">
      <SectionHead title="Needs you" count={needs.length} tone="attention" />
      <div className="home-needs">
        {needs.map((thread) => {
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
              className="home-need"
              role="group"
              aria-label={thread.title}
            >
              <StatusGlyph state="needs" size={14} />
              <div className="home-need__body">
                <span className="home-need__title">{thread.title}</span>
                <span className="home-need__detail">
                  <ProviderMark name={provider} />
                  <span>
                    {thread.hasPendingApprovals
                      ? "wants your approval to continue"
                      : "asked you a question"}
                  </span>
                  {project ? <span className="home-need__where">{project.title}</span> : null}
                  {node ? (
                    <span className="home-need__where">@{node.label.toLowerCase()}</span>
                  ) : null}
                  <span className="home-need__where">{relativeTime(thread.updatedAt, now)}</span>
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={open}>
                {thread.hasPendingApprovals ? "Review" : "Answer"}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const ACTIVITY_FILTERS: ReadonlyArray<{ value: CirceActivityFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "failed", label: "Failed" },
];

function HomeActivity({ catalog }: { readonly catalog: CirceMeshCatalog | null }) {
  const [filter, setFilter] = useState<CirceActivityFilter>("all");
  return (
    <section aria-label="Activity" className="home-section">
      <SectionHead title="Activity">
        <span className="home-segment" role="tablist" aria-label="Activity filter">
          {ACTIVITY_FILTERS.map((option) => (
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
      </SectionHead>
      <CirceLiveAgents catalog={catalog} filter={filter} />
    </section>
  );
}

/**
 * Home: what needs you, where work runs, and the place to tell Circe what to
 * do next. One column, ordered by urgency. A machine's setup opens in a
 * sheet so the page itself stays about work.
 */
export function CirceControlCenter({
  machine,
}: {
  /** A machine whose details should open, from a rail tile or a link. */
  readonly machine?: EnvironmentId;
} = {}) {
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
  const [selectedNodeId, setSelectedNodeId] = useState<EnvironmentId | null>(machine ?? null);
  // A new `machine` in the URL (a rail tile) opens that machine even when
  // Home is already showing.
  const [linkedMachine, setLinkedMachine] = useState(machine);
  if (machine !== linkedMachine) {
    setLinkedMachine(machine);
    setSelectedNodeId(machine ?? null);
  }
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
    () => view.devices.find((device) => device.node.nodeId === selectedNodeId) ?? null,
    [selectedNodeId, view.devices],
  );
  const liveCatalog = useMemo(
    () => (catalog === null ? null : { ...catalog, nodes: registeredNodes }),
    [catalog, registeredNodes],
  );

  return (
    <SidebarInset className="circe-control-center h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="home-title">Home</h1>
          <div className="ms-auto flex items-center gap-2">
            <Button size="sm" onClick={() => openCommandPalette({ open: "new-thread-in" })}>
              <SquarePenIcon /> New task
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="home">
            <HomeHeadline />
            <CirceCommandConsole catalog={liveCatalog} />
            {error ? (
              <div className="home-alert" role="alert">
                <CircleAlertIcon className="size-4 shrink-0" />
                <span className="flex-1">{error}</span>
                <Button size="xs" variant="outline" onClick={() => void refresh()}>
                  Try again
                </Button>
              </div>
            ) : null}
            <HomeNeeds catalog={liveCatalog} />
            <section aria-label="Machines" className="home-section">
              <SectionHead
                title="Machines"
                count={
                  view.devices.length > 0
                    ? `${view.summary.onlineDevices} of ${view.summary.devices} online`
                    : undefined
                }
              >
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => void navigate({ to: "/settings/connections" })}
                >
                  <PlusIcon /> Pair a machine
                </Button>
              </SectionHead>
              {pending && catalog === null && view.devices.length === 0 ? (
                <p className="home-note" role="status">
                  Finding your machines…
                </p>
              ) : view.devices.length === 0 ? (
                <p className="home-note">
                  No machines connected. Pair or reconnect one in Connections.
                </p>
              ) : (
                <MachinePlates
                  devices={view.devices}
                  selectedNodeId={selectedNodeId}
                  onSelect={setSelectedNodeId}
                />
              )}
              <CirceMeshDevices />
            </section>
            <HomeActivity catalog={liveCatalog} />
          </div>
        </ScrollArea>
      </div>
      <Sheet
        open={selectedDevice !== null}
        onOpenChange={(open) => {
          if (open) return;
          setSelectedNodeId(null);
          if (machine !== undefined) void navigate({ to: "/circe", search: {}, replace: true });
        }}
      >
        <SheetPopup side="right" className="home-sheet">
          {selectedDevice ? (
            <>
              <MachineHeader device={selectedDevice} />
              <div className="home-sheet__scroll">
                <div className="home-sheet__body">
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
                </div>
              </div>
            </>
          ) : null}
        </SheetPopup>
      </Sheet>
    </SidebarInset>
  );
}
