import { useAtomValue } from "@effect/atom-react";
import { CalendarClockIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@circe/contracts";
import { ProviderInstanceId } from "@circe/contracts";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@circe/client/state/runtime";

import { cn } from "../../lib/utils";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { SidebarInset } from "../ui/sidebar";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";
import "./scheduled.css";
import {
  LAST_RUN_WORDS,
  relativeLabel,
  scheduleLabel,
  useScheduledTasks,
  WEEKDAY_LABELS,
} from "./scheduleLabels";

type ScheduleMode = "fixed" | "interval";
type WorkspaceMode = "root" | "worktree" | "existing_worktree";

interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  /** Not editable in the dialog, but preserved so editing an agent-created task keeps its modes. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * The task's original model selection. The picker only edits
   * `instanceId:model`; keeping the source object preserves provider options
   * (reasoning, temperature, …) when the model itself is left unchanged.
   */
  readonly baseModelSelection: ModelSelection | null;
}

/** JS day-of-week (0 = Sunday) rendered Monday-first, matching how people read a week. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const ALL_WEEKDAYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6]);

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "Create a new worktree",
  root: "Use the project checkout",
  existing_worktree: "Use a specific checkout",
};

const EMPTY_DRAFT: DraftState = {
  editingId: null,
  title: "",
  prompt: "",
  enabled: true,
  scheduleMode: "fixed",
  intervalMinutes: "15",
  timeOfDay: "09:00",
  weekdays: new Set([1, 2, 3, 4, 5]),
  projectId: "",
  threadId: "",
  workspaceMode: "worktree",
  baseRef: "main",
  existingWorktreePath: "",
  modelKey: "",
  runtimeMode: "full-access",
  interactionMode: "default",
  baseModelSelection: null,
};

/** Labelled field: a caption sitting above its control. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label
        className="flex items-baseline justify-between gap-2 text-xs font-medium text-foreground"
        htmlFor={htmlFor}
      >
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-[11px] text-muted-foreground/80">{hint}</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

function modelKey(selection: ModelSelection): string {
  return `${selection.instanceId}:${selection.model}`;
}

function splitModelKey(value: string): ModelSelection | null {
  const index = value.indexOf(":");
  if (index <= 0 || index === value.length - 1) return null;
  return {
    instanceId: ProviderInstanceId.make(value.slice(0, index)),
    model: value.slice(index + 1),
  };
}

function scheduleFromDraft(draft: DraftState): ScheduledTaskSchedule {
  if (draft.scheduleMode === "interval") {
    const minutes = Math.max(1, Number.parseInt(draft.intervalMinutes, 10) || 1);
    return { type: "interval", everyMs: minutes * 60_000 };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set(ALL_WEEKDAYS);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode: schedule.type === "interval" ? "interval" : "fixed",
    intervalMinutes:
      schedule.type === "interval"
        ? String(Math.max(1, Math.round(schedule.everyMs / 60_000)))
        : "15",
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: modelKey(task.modelSelection),
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
  };
}

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

/** The canvas chrome: a breadcrumb title bar with the page's actions. */
function ScheduledFrame({
  crumbs,
  actions,
  children,
}: {
  readonly crumbs: ReadonlyArray<{ readonly label: string; readonly onClick?: () => void }>;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <nav className="sched-crumbs" aria-label="Breadcrumb">
            {crumbs.map((crumb, index) => (
              <span key={crumb.label} className="sched-crumbs__item">
                {index > 0 ? <span className="sched-crumbs__sep">/</span> : null}
                {crumb.onClick && index < crumbs.length - 1 ? (
                  <button type="button" onClick={crumb.onClick}>
                    {crumb.label}
                  </button>
                ) : (
                  <span aria-current={index === crumbs.length - 1 ? "page" : undefined}>
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-1.5">{actions}</div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="sched">{children}</div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

/**
 * One machine's schedules. With a schedule picked in the panel the canvas
 * shows that schedule; without one it shows the machine's schedules in the
 * order they will run.
 */
export function ScheduledTasksPage(target: {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId;
  readonly compose?: boolean;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(target.environmentId ?? primaryEnvironmentId);
  const tasksQuery = useScheduledTasks(environment?.environmentId ?? null);
  if (!environment || !tasksQuery.data) {
    return (
      <ScheduledFrame crumbs={[{ label: "Scheduled" }]}>
        <p className="sched-note" role="status">
          {tasksQuery.error ??
            (environment
              ? "Loading schedules…"
              : target.environmentId
                ? "The machine that owns this schedule is offline. Reconnect it to see its schedules."
                : "Connect a machine to schedule work on it.")}
        </p>
      </ScheduledFrame>
    );
  }
  return (
    <EnvironmentScheduledTasks
      key={environment.environmentId}
      environmentId={environment.environmentId}
      machineLabel={environment.label.toLowerCase()}
      taskId={target.taskId}
      compose={target.compose === true}
      tasks={tasksQuery.data.tasks}
      error={tasksQuery.error}
    />
  );
}

function EnvironmentScheduledTasks({
  environmentId,
  machineLabel,
  taskId,
  compose,
  tasks,
  error,
}: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly taskId: ScheduledTaskId | undefined;
  readonly compose: boolean;
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly error: string | null;
}) {
  useRelativeTimeTick(15_000);
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const upsertTask = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "scheduled task upsert",
  });
  const deleteTask = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "scheduled task delete",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "scheduled task run now",
  });
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  // The editor keeps its own draft: live task updates must not overwrite
  // what the user is typing.
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const editingTaskMissing =
    draft.editingId !== null && !tasks.some((task) => task.id === draft.editingId);
  const selectedProjectTitle = projects.find((project) => project.id === draft.projectId)?.title;

  // The real model picker is keyed by a `${instanceId}:${model}` string, which
  // is exactly how the draft stores its selection.
  const firstInstance = instanceEntries[0];
  const defaultModelKey =
    firstInstance && firstInstance.models[0]
      ? `${firstInstance.instanceId}:${firstInstance.models[0].slug}`
      : "";
  const activeSelection = splitModelKey(draft.modelKey || defaultModelKey);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, activeInstanceId, activeModel),
    [settings, providers, activeInstanceId, activeModel],
  );

  const openForCreate = useCallback(() => {
    setDraft({
      ...EMPTY_DRAFT,
      projectId: projects[0]?.id ?? "",
      modelKey: defaultModelKey,
    });
    setDialogOpen(true);
  }, [defaultModelKey, projects]);

  const openForEdit = useCallback((task: ScheduledTask) => {
    setDraft(taskToDraft(task));
    setDialogOpen(true);
  }, []);

  const submit = useCallback(async () => {
    if (saving || editingTaskMissing) return;
    const selection = splitModelKey(draft.modelKey || defaultModelKey);
    if (!draft.title.trim() || !draft.prompt.trim() || !draft.projectId || selection === null) {
      reportFailure("Schedule is incomplete", "Add a title, prompt, project, and model.");
      return;
    }
    // Keep the original selection object (with provider options) when the
    // picker still points at the same instance+model.
    const modelSelection =
      draft.baseModelSelection !== null &&
      draft.baseModelSelection.instanceId === selection.instanceId &&
      draft.baseModelSelection.model === selection.model
        ? draft.baseModelSelection
        : selection;
    const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      draft.workspaceMode === "root"
        ? { type: "root" }
        : draft.workspaceMode === "existing_worktree"
          ? { type: "existing_worktree", worktreePath: draft.existingWorktreePath.trim() }
          : { type: "worktree", baseRef: draft.baseRef.trim() || "main", startFromOrigin: true };
    const input: ScheduledTaskUpsertInput = {
      ...(draft.editingId ? { id: draft.editingId as ScheduledTaskId } : {}),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule: scheduleFromDraft(draft),
      projectId: draft.projectId as ProjectId,
      threadId: draft.threadId ? (draft.threadId as ThreadId) : null,
      workspaceStrategy,
      modelSelection,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
      creationSource: "web",
    };
    setSaving(true);
    const result = await upsertTask({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not save schedule", squashAtomCommandFailure(result));
      }
      return;
    }
    setDialogOpen(false);
  }, [defaultModelKey, draft, editingTaskMissing, environmentId, saving, upsertTask]);

  const handleDelete = useCallback(
    async (task: ScheduledTask) => {
      const result = await deleteTask({
        environmentId,
        input: { id: task.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not delete schedule", squashAtomCommandFailure(result));
      }
    },
    [deleteTask, environmentId],
  );

  const handleRunNow = useCallback(
    async (task: ScheduledTask) => {
      const result = await runTaskNow({
        environmentId,
        input: { id: task.id },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not run schedule", squashAtomCommandFailure(result));
      }
    },
    [environmentId, runTaskNow],
  );

  // Keep the draft pointed at a real project once projects load, so a freshly
  // opened dialog is never stuck on an empty project select.
  useEffect(() => {
    if (draft.projectId || projects.length === 0) return;
    setDraft((current) => ({
      ...current,
      projectId: projects[0]?.id ?? "",
      modelKey: current.modelKey || defaultModelKey,
    }));
  }, [defaultModelKey, draft.projectId, projects]);

  const navigate = useNavigate();
  const selectTask = useCallback(
    (id: ScheduledTaskId | undefined) =>
      void navigate({
        to: "/scheduled",
        search: id === undefined ? { environmentId } : { environmentId, taskId: id },
      }),
    [environmentId, navigate],
  );

  // The panel's "New schedule" arrives as a one-shot flag in the URL: open
  // the editor when the flag appears, then drop it so a reload or back does
  // not reopen the editor.
  const [seenCompose, setSeenCompose] = useState(false);
  if (compose !== seenCompose) {
    setSeenCompose(compose);
    if (compose) openForCreate();
  }
  useEffect(() => {
    if (!compose) return;
    void navigate({
      to: "/scheduled",
      search: taskId === undefined ? { environmentId } : { environmentId, taskId },
      replace: true,
    });
  }, [compose, environmentId, navigate, taskId]);

  const setEnabled = useCallback(
    async (task: ScheduledTask, enabled: boolean) => {
      const result = await upsertTask({
        environmentId,
        input: {
          id: task.id,
          title: task.title,
          prompt: task.prompt,
          enabled,
          schedule: task.schedule,
          projectId: task.projectId,
          threadId: task.threadId,
          workspaceStrategy: task.workspaceStrategy,
          modelSelection: task.modelSelection,
          runtimeMode: task.runtimeMode,
          interactionMode: task.interactionMode,
          creationSource: "web",
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure(
          enabled ? "Could not resume schedule" : "Could not pause schedule",
          squashAtomCommandFailure(result),
        );
      }
    },
    [environmentId, upsertTask],
  );

  const upcoming = useMemo(
    () =>
      tasks.toSorted((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
        return (left.nextRunAt ?? "￿").localeCompare(right.nextRunAt ?? "￿");
      }),
    [tasks],
  );
  const selected = taskId === undefined ? undefined : tasks.find((task) => task.id === taskId);
  const crumbs = [
    { label: "Scheduled" },
    { label: machineLabel, onClick: () => selectTask(undefined) },
    ...(selected ? [{ label: selected.title }] : []),
  ];

  return (
    <ScheduledFrame
      crumbs={crumbs}
      actions={
        selected ? (
          <>
            <Button size="sm" variant="outline" onClick={() => void handleRunNow(selected)}>
              <PlayIcon /> Run now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => openForEdit(selected)}>
              <PencilIcon /> Edit
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${selected.title}`}
                    onClick={() => {
                      void handleDelete(selected);
                      selectTask(undefined);
                    }}
                  />
                }
              >
                <Trash2Icon />
              </TooltipTrigger>
              <TooltipPopup>Delete</TooltipPopup>
            </Tooltip>
          </>
        ) : tasks.length > 0 ? (
          <Button size="sm" onClick={openForCreate}>
            <PlusIcon /> New schedule
          </Button>
        ) : null
      }
    >
      {taskId && !selected ? (
        <p className="sched-note" role="status">
          That schedule no longer exists on {machineLabel}.
        </p>
      ) : null}
      {error ? (
        <p className="sched-note sched-note--error" role="alert">
          {error}
        </p>
      ) : selected ? (
        <ScheduleDetail
          task={selected}
          projectTitle={projects.find((project) => project.id === selected.projectId)?.title}
          onEnabledChange={(enabled) => void setEnabled(selected, enabled)}
        />
      ) : tasks.length === 0 ? (
        <div className="sched-empty">
          <CalendarClockIcon className="sched-empty__icon" strokeWidth={1.25} />
          <h2>Nothing scheduled on {machineLabel}</h2>
          <p>
            A schedule runs a prompt in one of {machineLabel}&rsquo;s projects at a fixed time or on
            an interval.
          </p>
          <Button size="sm" onClick={openForCreate}>
            <PlusIcon /> New schedule
          </Button>
        </div>
      ) : (
        <>
          <h2 className="sched-heading">Up next on {machineLabel}</h2>
          <ul className="sched-list">
            {upcoming.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="sched-row"
                  data-enabled={task.enabled ? "true" : "false"}
                  onClick={() => selectTask(task.id)}
                >
                  <span className="sched-row__when">
                    {task.enabled ? relativeLabel(task.nextRunAt) : "Paused"}
                  </span>
                  <span className="sched-row__main">
                    <span className="sched-row__title">{task.title}</span>
                    <span className="sched-row__meta">
                      {scheduleLabel(task.schedule)}
                      {projects.find((project) => project.id === task.projectId)?.title
                        ? `, in ${projects.find((project) => project.id === task.projectId)?.title}`
                        : ""}
                    </span>
                  </span>
                  <span className="sched-row__last" data-status={task.lastRunStatus}>
                    {LAST_RUN_WORDS[task.lastRunStatus]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{draft.editingId ? "Edit schedule" : "New schedule"}</DialogTitle>
            <DialogDescription>
              Run a prompt on {machineLabel} at a fixed time or on an interval.
            </DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-5">
            {editingTaskMissing ? (
              <p className="text-xs text-destructive" role="status">
                This schedule no longer exists.
              </p>
            ) : null}
            <Field label="Name" htmlFor="scheduled-task-title">
              <Input
                id="scheduled-task-title"
                placeholder="e.g. Check for Sentry issues"
                value={draft.title}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.target.value }))
                }
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Project">
                <Select
                  value={draft.projectId}
                  onValueChange={(projectId) =>
                    setDraft((current) => ({ ...current, projectId: projectId ?? "" }))
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue placeholder="Select a project">{selectedProjectTitle}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>

              <Field label="Workspace">
                <Select
                  value={draft.workspaceMode}
                  onValueChange={(value) =>
                    setDraft((current) => ({ ...current, workspaceMode: value as WorkspaceMode }))
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue>{WORKSPACE_MODE_LABELS[draft.workspaceMode]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="worktree">Create a new worktree</SelectItem>
                    <SelectItem value="root">Use the project checkout</SelectItem>
                    <SelectItem value="existing_worktree">Use a specific checkout</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
            </div>

            {draft.workspaceMode === "worktree" ? (
              <Field label="Base ref" htmlFor="scheduled-task-base-ref">
                <Input
                  id="scheduled-task-base-ref"
                  value={draft.baseRef}
                  placeholder="main"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, baseRef: event.target.value }))
                  }
                />
              </Field>
            ) : null}
            {draft.workspaceMode === "existing_worktree" ? (
              <Field label="Checkout path" htmlFor="scheduled-task-checkout">
                <Input
                  id="scheduled-task-checkout"
                  value={draft.existingWorktreePath}
                  placeholder="/path/to/checkout"
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      existingWorktreePath: event.target.value,
                    }))
                  }
                />
              </Field>
            ) : null}

            <Field label="Prompt" htmlFor="scheduled-task-prompt">
              <Textarea
                id="scheduled-task-prompt"
                placeholder="What should the agent do each time this runs?"
                value={draft.prompt}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, prompt: event.target.value }))
                }
              />
            </Field>

            <Field label="Model">
              <ProviderModelPicker
                activeInstanceId={activeInstanceId}
                model={activeModel}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerVariant="outline"
                triggerClassName="w-full max-w-none justify-between text-foreground/90 hover:text-foreground"
                onInstanceModelChange={(instanceId, model) =>
                  setDraft((current) => ({ ...current, modelKey: `${instanceId}:${model}` }))
                }
              />
            </Field>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">Schedule</span>
                <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/70 bg-muted/40 p-0.5">
                  {(
                    [
                      ["fixed", "Daily"],
                      ["interval", "Interval"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={draft.scheduleMode === mode}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        draft.scheduleMode === mode
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setDraft((current) => ({ ...current, scheduleMode: mode }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {draft.scheduleMode === "fixed" ? (
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Run at</span>
                    <Input
                      type="time"
                      nativeInput
                      className="w-32"
                      value={draft.timeOfDay}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                      }
                    />
                    <span className="text-xs text-muted-foreground">on</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAY_ORDER.map((day) => {
                      const selected = draft.weekdays.has(day);
                      return (
                        <button
                          key={day}
                          type="button"
                          aria-pressed={selected}
                          aria-label={WEEKDAY_LABELS[day]}
                          className={cn(
                            "grid size-8 place-items-center rounded-full border text-[11px] font-semibold transition-colors",
                            selected
                              ? "border-primary bg-primary text-primary-foreground shadow-xs"
                              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                          onClick={() =>
                            setDraft((current) => {
                              const weekdays = new Set(current.weekdays);
                              if (weekdays.has(day)) {
                                // Keep at least one day selected: an empty set
                                // would silently persist as a daily schedule.
                                if (weekdays.size === 1) return current;
                                weekdays.delete(day);
                              } else {
                                weekdays.add(day);
                              }
                              return { ...current, weekdays };
                            })
                          }
                        >
                          {WEEKDAY_SHORT[day]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Run every</span>
                  <Input
                    type="number"
                    nativeInput
                    min={1}
                    className="w-24"
                    value={draft.intervalMinutes}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                    }
                  />
                  <span className="text-xs text-muted-foreground">minutes</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
              <div className="min-w-0">
                <div className="text-xs font-medium">Enabled</div>
                <div className="text-[11px] text-muted-foreground">
                  Disabled tasks stay saved but do not run.
                </div>
              </div>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </div>
          </DialogPanel>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
            <Button size="sm" disabled={saving || editingTaskMissing} onClick={() => void submit()}>
              {draft.editingId ? "Save schedule" : "Create schedule"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </ScheduledFrame>
  );
}

function workspaceLabel(strategy: ScheduledTask["workspaceStrategy"]): string {
  if (strategy.type === "worktree") return `New worktree from ${strategy.baseRef}`;
  if (strategy.type === "existing_worktree") return strategy.worktreePath;
  return "The project checkout";
}

/** One schedule, read top to bottom: when it runs, how it last went, what it runs. */
function ScheduleDetail({
  task,
  projectTitle,
  onEnabledChange,
}: {
  readonly task: ScheduledTask;
  readonly projectTitle: string | undefined;
  readonly onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <article className="sched-detail">
      <header className="sched-detail__head">
        <h2>{task.title}</h2>
        <label className="sched-detail__toggle">
          <Switch checked={task.enabled} onCheckedChange={onEnabledChange} />
          {task.enabled ? "On" : "Paused"}
        </label>
      </header>
      <p className="sched-detail__lead">
        {scheduleLabel(task.schedule)}.{" "}
        {task.enabled
          ? `Next run ${relativeLabel(task.nextRunAt)}.`
          : "Paused, so it will not run."}
      </p>
      <dl className="sched-facts">
        <div>
          <dt>Last run</dt>
          <dd data-status={task.lastRunStatus}>
            {LAST_RUN_WORDS[task.lastRunStatus]}
            {task.lastRunAt ? `, ${relativeLabel(task.lastRunAt)}` : ""}
          </dd>
        </div>
        <div>
          <dt>Runs so far</dt>
          <dd>{task.runCount}</dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>{projectTitle ?? "Project unavailable"}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{task.modelSelection.model}</dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>{workspaceLabel(task.workspaceStrategy)}</dd>
        </div>
      </dl>
      {task.lastRunError ? <p className="sched-detail__error">{task.lastRunError}</p> : null}
      <section className="sched-detail__prompt">
        <h3>Prompt</h3>
        <p>{task.prompt}</p>
      </section>
    </article>
  );
}
