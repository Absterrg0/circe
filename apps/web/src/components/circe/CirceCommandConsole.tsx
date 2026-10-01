import {
  isChatWorkspace,
  type CirceProjectRef,
  type CirceTaskPendingReply,
  type CirceTaskRef,
  type CirceTaskState,
  type ThreadId,
} from "@circe/contracts";
import type { CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";
import { buildCirceVoiceWaitingView } from "@circe/client-runtime/circe/voiceWaiting";
import {
  ActivityIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  FolderGit2Icon,
  ListTodoIcon,
  MicIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  getCirceCommandState,
  getCirceLastCommandFeedback,
  getCirceTargetSnapshot,
  onCirceCommandFeedback,
  onCirceCommandState,
  onCirceTargetSnapshot,
  requestCirceCommandAction,
  requestCirceTarget,
  submitCirceComposerCommand,
  type CirceCommandFeedback,
  type CirceTargetSnapshot,
} from "../../circeBus";
import { cn, randomUUID } from "../../lib/utils";
import { circeMeshEnvironment } from "../../state/circeMesh";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  getCirceLiveVoiceUiState,
  setCirceLiveVoiceActive,
  subscribeCirceLiveVoice,
} from "./CirceLiveVoice.bridge";
import { CirceOrb, type CirceOrbState } from "./CirceOrb";
import { circePresenceMode } from "./CircePresence.logic";

interface ConsoleTask {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly state: CirceTaskState;
  readonly projectRef: CirceProjectRef;
  readonly taskRef?: CirceTaskRef;
  readonly pendingReply?: CirceTaskPendingReply | null;
}

/** A starting instruction offered under the box. Picking one fills the box; it never sends. */
export interface CirceCommandSuggestion {
  readonly label: string;
  readonly icon: ReactNode;
  readonly text: string;
}

const NO_SUGGESTIONS: ReadonlyArray<CirceCommandSuggestion> = [];

const PRESENCE_LABEL = {
  idle: "Ready",
  listening: "Listening",
  working: "Working",
  speaking: "Speaking",
  attention: "Needs you",
  error: "Needs attention",
} as const;

/**
 * The one place to tell Circe what to do. Text and live voice go through the
 * same typed command runtime; the project and task pickers only narrow the
 * target, and stay locked while a command is in flight so an answer cannot
 * land on a different target than the question.
 */
export function CirceCommandConsole({
  catalog,
  suggestions = NO_SUGGESTIONS,
}: {
  readonly catalog: CirceMeshCatalog | null;
  readonly suggestions?: ReadonlyArray<CirceCommandSuggestion>;
}) {
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [feedback, setFeedback] = useState<CirceCommandFeedback | null>(() =>
    getCirceLastCommandFeedback(),
  );
  const [targetSnapshot, setTargetSnapshot] = useState<CirceTargetSnapshot | null>(() =>
    getCirceTargetSnapshot(),
  );
  const [commandState, setCommandState] = useState(getCirceCommandState);
  const { pending: commandPending, busy: commandBusy, awaitingAnswer, canRetry } = commandState;
  const [tasks, setTasks] = useState<ReadonlyArray<ConsoleTask>>([]);
  const [liveVoice, setLiveVoice] = useState(getCirceLiveVoiceUiState);
  const getTaskDesk = useAtomCommand(circeMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(() => onCirceCommandFeedback((entry) => setFeedback(entry)), []);
  useEffect(() => subscribeCirceLiveVoice(() => setLiveVoice(getCirceLiveVoiceUiState())), []);
  useEffect(() => onCirceTargetSnapshot((snapshot) => setTargetSnapshot(snapshot)), []);
  useEffect(() => onCirceCommandState(setCommandState), []);

  // Keep the task picker useful before the user chooses an explicit project.
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
  // paused or queued work and the answer goes through Send. Both come from
  // typed runtime state, not feedback wording.
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
      : `${targetSnapshot.projectTitle ?? targetProject?.title ?? "Project unavailable"} on ${targetSnapshot.nodeLabel ?? targetNode?.label ?? "an unavailable machine"}${
          targetSnapshot.contextThreadTitle !== undefined
            ? ` · ${targetSnapshot.contextThreadTitle}`
            : targetSnapshot.contextThreadId !== undefined
              ? ` · ${targetSnapshot.contextThreadId}`
              : ""
        }${targetSnapshot.available === false ? " (unavailable)" : ""}`;
  // Visible only while a submission is dispatched and unanswered. No
  // animation, so reduced motion needs no special case.
  const waitingView = buildCirceVoiceWaitingView({
    busy: commandBusy,
    awaitingAnswer,
    feedbackKind: feedback?.kind ?? null,
    feedbackText: feedback?.text ?? null,
    targetLabel,
    targetAvailable: targetSnapshot?.available ?? false,
  });
  const activeTask = tasks.find((task) => task.threadId === targetSnapshot?.contextThreadId);
  const selectedProjectKey = targetSnapshot?.projectRef
    ? `${targetSnapshot.projectRef.nodeId}:${targetSnapshot.projectRef.projectId}`
    : "";
  const selectedProjectLabel = targetProject
    ? `${targetProject.title} · ${targetProject.nodeLabel}`
    : "Any project";
  const presenceMode = circePresenceMode({
    listening: liveVoice.active && liveVoice.status === "live",
    submitting: commandBusy,
    activeTaskState: activeTask?.state ?? null,
    error: feedback?.kind === "error" ? feedback.text : null,
  });
  const orbState: CirceOrbState =
    presenceMode === "listening" || presenceMode === "speaking" ? "listening" : presenceMode;

  return (
    <section aria-label="Circe command" className="circe-console min-w-0">
      <div className="circe-composer-frame">
        <textarea
          ref={composerRef}
          aria-label="Circe instruction"
          className="circe-composer w-full"
          placeholder={
            awaitingAnswer ? "Answer Circe…" : "Tell Circe what to do, on any of your machines…"
          }
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              sendDraft();
            }
          }}
        />
        <div className="circe-composer-footer">
          <div className="circe-command-fields">
            <Menu>
              <MenuTrigger
                aria-label="Circe project target"
                className="circe-chip"
                data-selected={Boolean(targetSnapshot?.projectRef)}
                disabled={commandPending}
              >
                <FolderGit2Icon aria-hidden className="size-3.5 shrink-0" />
                <span className="circe-select circe-select__label">{selectedProjectLabel}</span>
                <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
              </MenuTrigger>
              <MenuPopup align="start" className="max-h-80 w-max min-w-52 max-w-72 overflow-y-auto">
                <MenuRadioGroup
                  aria-label="Circe project options"
                  value={selectedProjectKey}
                  onValueChange={(value) => {
                    if (value === selectedProjectKey) return;
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
                  <MenuRadioItem value="" closeOnClick>
                    Any project
                  </MenuRadioItem>
                  {projects.map((project) => (
                    <MenuRadioItem
                      key={`${project.ref.nodeId}:${project.ref.projectId}`}
                      value={`${project.ref.nodeId}:${project.ref.projectId}`}
                      closeOnClick
                    >
                      <span className="block min-w-0 truncate">
                        {project.title} · {project.nodeLabel}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
            {tasks.length > 0 ? (
              <Menu>
                <MenuTrigger
                  aria-label="Circe task target"
                  className="circe-chip"
                  data-selected={Boolean(targetSnapshot?.contextThreadId)}
                  disabled={commandPending}
                >
                  <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="circe-select circe-select__label">
                    {activeTask?.title ?? "New task"}
                  </span>
                  <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
                </MenuTrigger>
                <MenuPopup
                  align="start"
                  className="max-h-80 w-max min-w-52 max-w-72 overflow-y-auto"
                >
                  <MenuRadioGroup
                    aria-label="Circe task options"
                    value={targetSnapshot?.contextThreadId ?? ""}
                    onValueChange={(threadId) => {
                      if (threadId === "" || threadId === targetSnapshot?.contextThreadId) return;
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
                    <MenuRadioItem value="" closeOnClick disabled>
                      New task
                    </MenuRadioItem>
                    <MenuSeparator />
                    {tasks.map((task) => (
                      <MenuRadioItem key={task.threadId} value={task.threadId} closeOnClick>
                        <span className="block min-w-0 truncate">{task.title}</span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuPopup>
              </Menu>
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
            <span className="circe-presence" data-state={presenceMode} aria-live="polite">
              <CirceOrb state={orbState} size="sm" />
              {PRESENCE_LABEL[presenceMode]}
            </span>
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
              size="icon-sm"
              variant="ghost"
              className="circe-voice-button"
              aria-pressed={liveVoice.active}
              aria-label={
                liveVoice.active
                  ? liveVoice.status === "live"
                    ? "End voice conversation"
                    : liveVoice.status === "closing"
                      ? "Ending voice conversation"
                      : "Connecting voice"
                  : "Talk to Circe"
              }
              title={liveVoice.active ? "End voice conversation" : "Talk to Circe"}
              disabled={!liveVoice.active && catalog === null}
              onClick={() => setCirceLiveVoiceActive(!liveVoice.active)}
            >
              <MicIcon className="size-4" />
            </Button>
            <Button
              className="circe-send-button"
              size="icon-sm"
              aria-label={commandBusy ? "Working" : awaitingAnswer ? "Send answer" : "Send"}
              title="Send (Enter)"
              disabled={sendDisabled}
              onClick={sendDraft}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </div>
        </div>
      </div>
      {liveVoice.active || targetSnapshot?.projectRef ? (
        <p className="circe-target-context" aria-live="polite">
          {liveVoice.active
            ? "Voice conversation is on and owns the microphone. End it to type."
            : `Working in ${targetLabel}`}
        </p>
      ) : null}
      {suggestions.length > 0 && !awaitingAnswer && !liveVoice.active ? (
        <div className="circe-suggestions" aria-label="Suggestions">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              className="circe-suggestion"
              disabled={commandPending}
              onClick={() => {
                setDraft(suggestion.text);
                const composer = composerRef.current;
                if (composer === null) return;
                composer.focus();
                // Leave the caret at the end so the user can finish the sentence.
                requestAnimationFrame(() =>
                  composer.setSelectionRange(suggestion.text.length, suggestion.text.length),
                );
              }}
            >
              {suggestion.icon}
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
      {waitingView ? (
        <div aria-live="polite" className="circe-feedback circe-feedback-waiting">
          <ActivityIcon className="size-4 shrink-0" />
          <div>
            <p className="text-xs font-medium text-foreground">{waitingView.targetNote}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{waitingView.correctionHint}</p>
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
    </section>
  );
}
