import {
  CIRCE_CONVERSATIONS_PROJECT_TITLE,
  CommandId,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@circe/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { taskTitle } from "../controllerHelpers.ts";
import type { CirceHost, HostSnapshot, PendingRequest, Project, Step, Thread } from "./core.ts";

/**
 * This node as a Circe host: its projects and threads as Circe's world, and
 * Circe's operations as ordinary orchestration commands. Nothing here decides
 * anything; Circe does, and every command goes through the same orchestrator
 * the coding UI uses, so the UI shows Circe's work as the user's own.
 */

/** Threads described in full each turn; the rest are listed by title. */
const DETAILED_THREADS = 12;
/** Closed threads Circe can still find and reopen. */
const ARCHIVED_THREADS = 20;
const RECENT_STEPS = 6;
const MAX_TEXT = 300;

/** An operation this node could not carry out; its message is what Circe tells the user. */
export class CirceHostOperationError extends Schema.TaggedError<CirceHostOperationError>()(
  "CirceHostOperationError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const refuse = (reason: string) => Effect.fail(new CirceHostOperationError({ reason }));

interface ThreadDetail {
  readonly updatedAt: number;
  readonly activity: ReadonlyArray<Step & { readonly at: number }>;
  readonly touched: ReadonlyArray<string>;
  readonly lastAgentMessage?: string;
  readonly queued: ReadonlyArray<{ readonly runId: RunId; readonly text: string }>;
  readonly pending?: PendingRequest & { readonly questionIds: ReadonlyArray<string> };
}

export const makeNodeHost = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const projections = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect);

  const details = new Map<string, ThreadDetail>();
  const tasks = new Map<string, string>();
  const described = new Map<string, Pick<Project, "about" | "areas">>();
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const detailFor = (shell: OrchestrationV2ThreadShell) =>
    Effect.gen(function* () {
      const updatedAt = DateTime.toEpochMillis(shell.updatedAt);
      const cached = details.get(shell.id);
      if (cached !== undefined && cached.updatedAt === updatedAt) return cached;
      const window = yield* orchestrator.getThreadSnapshotWindow(shell.id, {
        rowLimit: 80,
        userTurnLimit: 3,
      });
      const detail = readDetail(window.projection, shell, updatedAt);
      details.set(shell.id, detail);
      return detail;
    });

  const snapshot = Effect.gen(function* () {
    const [projectShells, active, archive, now] = yield* Effect.all([
      projections.getProjectShells(),
      orchestrator.getShellSnapshot({ location: "active" }),
      orchestrator.getShellSnapshot({ location: "archive" }),
      DateTime.now,
    ]);
    const shown = projectShells;
    const projectIds = new Set(shown.map((project) => project.id));
    const byRecency = (left: OrchestrationV2ThreadShell, right: OrchestrationV2ThreadShell) =>
      DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt);
    const open = active.threads
      .filter((thread) => thread.deletedAt === null && projectIds.has(thread.projectId))
      .toSorted(byRecency);
    const openIds = new Set(open.map((thread) => thread.id));
    const closed = [
      ...new Map(
        [...active.archivedThreads, ...archive.threads, ...archive.archivedThreads].map(
          (thread) => [thread.id, thread],
        ),
      ).values(),
    ]
      .filter(
        (thread) =>
          !openIds.has(thread.id) && thread.deletedAt === null && projectIds.has(thread.projectId),
      )
      .toSorted(byRecency)
      .slice(0, ARCHIVED_THREADS);
    const detailed = open.filter(
      (thread, index) => index < DETAILED_THREADS || thread.pendingRuntimeRequest !== null,
    );
    const loaded = yield* Effect.forEach(
      detailed,
      (thread) => detailFor(thread).pipe(Effect.option),
      { concurrency: 4 },
    );
    const detailById = new Map(
      detailed.flatMap((thread, index) =>
        loaded[index]?._tag === "Some" ? [[thread.id, loaded[index].value] as const] : [],
      ),
    );
    const projects = yield* Effect.forEach(shown, describeProject, { concurrency: 4 });
    const nowMs = DateTime.toEpochMillis(now);
    const threads = [
      ...open.map((thread) => toThread(thread, detailById.get(thread.id), false, nowMs)),
      ...closed.map((thread) => toThread(thread, undefined, true, nowMs)),
    ];
    return { projects, threads, focus: {} } satisfies HostSnapshot;
  });

  const describeProject = (project: OrchestrationProjectShell) =>
    Effect.gen(function* () {
      // The node's Conversations project is where its agents answer general
      // questions with live data; Circe sends questions about nothing in the
      // user's projects there.
      if (project.title === CIRCE_CONVERSATIONS_PROJECT_TITLE) {
        return {
          id: project.id,
          name: project.title,
          about: "General questions and requests that are not about a coding project.",
          general: true,
        } satisfies Project;
      }
      let description = described.get(project.id);
      if (description === undefined) {
        description = yield* describeWorkspace(project.workspaceRoot);
        described.set(project.id, description);
      }
      return { id: project.id, name: project.title, ...description } satisfies Project;
    });

  /** A line about the project from its README, and its main areas, so Circe can match how the user refers to it. */
  const describeWorkspace = (root: string) =>
    Effect.gen(function* () {
      const readme = yield* fs
        .readFileString(path.join(root, "README.md"))
        .pipe(Effect.orElseSucceed(() => ""));
      const about =
        readme
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .find((line) => line.length > 20 && !/^(#|!\[|\[!|<|>|```|\||-{3})/u.test(line)) ?? "";
      const directories = (directory: string) =>
        fs.readDirectory(directory).pipe(
          Effect.flatMap((names) =>
            Effect.filter(
              names.filter((name) => !name.startsWith(".") && name !== "node_modules"),
              (name) =>
                fs
                  .stat(path.join(directory, name))
                  .pipe(Effect.map((info) => info.type === "Directory")),
            ),
          ),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
      const areas: string[] = [];
      for (const name of yield* directories(root)) {
        if (name === "apps" || name === "packages" || name === "services" || name === "crates") {
          areas.push(
            ...(yield* directories(path.join(root, name))).map((child) => `${name}/${child}`),
          );
        } else {
          areas.push(name);
        }
      }
      return { about: clip(about), ...(areas.length === 0 ? {} : { areas: areas.slice(0, 12) }) };
    });

  const toThread = (
    shell: OrchestrationV2ThreadShell,
    detail: ThreadDetail | undefined,
    archived: boolean,
    now: number,
  ): Thread => {
    const latest = shell.latestVisibleMessage;
    const agentText = latest?.role === "assistant" ? latest.text : detail?.lastAgentMessage;
    const lastAgentMessage =
      shell.status === "failed" && shell.lastError ? shell.lastError : agentText;
    const pending = detail?.pending;
    return {
      id: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      runState: runState(shell),
      ...(pending === undefined || archived
        ? {}
        : { pending: { id: pending.id, kind: pending.kind, text: pending.text } }),
      lastActivityMinutesAgo: Math.max(0, (now - DateTime.toEpochMillis(shell.updatedAt)) / 60_000),
      task: tasks.get(shell.id) ?? shell.title,
      ...(latest?.role === "user" ? { lastUserMessage: clip(latest.text) } : {}),
      ...(lastAgentMessage === undefined ? {} : { lastAgentMessage: clip(lastAgentMessage) }),
      queued: detail?.queued.map((entry) => entry.text) ?? [],
      ...(detail === undefined
        ? {}
        : {
            activity: detail.activity.map(({ at, ...step }) => ({
              ...step,
              minutesAgo: Math.max(0, (now - at) / 60_000),
            })),
            touched: detail.touched,
          }),
      ...(archived ? { archived: true } : {}),
    };
  };

  const threadShell = (threadId: string) =>
    orchestrator
      .getThreadShell(ThreadId.make(threadId))
      .pipe(
        Effect.flatMap((shell) =>
          shell === null ? refuse("that thread no longer exists") : Effect.succeed(shell),
        ),
      );

  const defaultModel = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* projections.getProjectShellById(projectId);
      const configured = yield* settings.getSettings;
      const selection: ModelSelection | null =
        (project._tag === "Some" ? project.value.defaultModelSelection : null) ??
        configured.circeDefaultModelSelection ??
        configured.defaultModelSelection;
      if (selection === null)
        return yield* refuse("no default model is set; choose one in Settings");
      return selection;
    });

  const creation = { createdBy: "user", creationSource: "server" } as const;

  const send = (
    threadId: ThreadId,
    text: string,
    dispatchMode:
      | { readonly type: "start_immediately" }
      | { readonly type: "queue_after_active" }
      | { readonly type: "steer_active"; readonly targetRunId: RunId },
  ) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(yield* uuid),
        threadId,
        messageId: MessageId.make(yield* uuid),
        text,
        attachments: [],
        dispatchMode,
        ...creation,
      });
    });

  const host: CirceHost = {
    state: () => run(snapshot),

    start: (projectId, text) =>
      run(
        Effect.gen(function* () {
          const project = ProjectId.make(projectId);
          const modelSelection = yield* defaultModel(project);
          const threadId = ThreadId.make(yield* uuid);
          const title = taskTitle(text);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* uuid),
            threadId,
            projectId: project,
            title,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            ...creation,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(yield* uuid),
            threadId,
            messageId: MessageId.make(yield* uuid),
            text,
            attachments: [],
            modelSelection,
            titleSeed: title,
            dispatchMode: { type: "start_immediately" },
            ...creation,
          });
          tasks.set(threadId, text);
          return threadId as string;
        }),
      ),

    deliver: (threadId, text, delivery) =>
      run(
        Effect.gen(function* () {
          const shell = yield* threadShell(threadId);
          if (delivery.mode === "reply") {
            const pending = (yield* detailFor(shell)).pending;
            if (pending?.id !== delivery.requestId || pending.questionIds.length === 0) {
              return yield* send(shell.id, text, { type: "start_immediately" });
            }
            yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make(yield* uuid),
              threadId: shell.id,
              requestId: RuntimeRequestId.make(pending.id),
              answers: Object.fromEntries(
                pending.questionIds.map((questionId) => [questionId, text]),
              ),
            });
            return;
          }
          if (shell.archivedAt !== null) {
            yield* orchestrator.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(yield* uuid),
              threadId: shell.id,
            });
          }
          if (delivery.mode === "steer" && shell.activeRunId !== null) {
            return yield* send(shell.id, text, {
              type: "steer_active",
              targetRunId: shell.activeRunId,
            });
          }
          if (delivery.mode === "queue" && shell.activeRunId !== null) {
            return yield* send(shell.id, text, { type: "queue_after_active" });
          }
          return yield* send(shell.id, text, { type: "start_immediately" });
        }),
      ),

    respond: (threadId, requestId, decision) =>
      run(
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "runtime-request.respond",
            commandId: CommandId.make(yield* uuid),
            threadId: ThreadId.make(threadId),
            requestId: RuntimeRequestId.make(requestId),
            decision: decision === "approve" ? "accept" : "decline",
          });
        }),
      ),

    stop: (threadId) =>
      run(
        Effect.gen(function* () {
          const shell = yield* threadShell(threadId);
          if (shell.activeRunId === null) return;
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make(yield* uuid),
            threadId: shell.id,
            runId: shell.activeRunId,
            reason: "Stopped by the user through Circe.",
          });
        }),
      ),

    close: (threadId) =>
      run(
        Effect.gen(function* () {
          const shell = yield* threadShell(threadId);
          if (shell.activeRunId !== null) {
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make(yield* uuid),
              threadId: shell.id,
              runId: shell.activeRunId,
            });
          }
          yield* orchestrator.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(yield* uuid),
            threadId: shell.id,
          });
        }),
      ),

    withdraw: (threadId, text) =>
      run(
        Effect.gen(function* () {
          const shell = yield* threadShell(threadId);
          details.delete(shell.id);
          const queued = (yield* detailFor(shell)).queued.findLast((entry) => entry.text === text);
          if (queued === undefined) return yield* refuse("that message already started");
          yield* orchestrator.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(yield* uuid),
            threadId: shell.id,
            runId: queued.runId,
          });
        }),
      ),
  };
  return host;
});

function runState(shell: OrchestrationV2ThreadShell): Thread["runState"] {
  if (shell.activeRunId !== null) return "running";
  switch (shell.status) {
    case "preparing":
    case "starting":
    case "running":
    case "waiting":
      return "running";
    case "failed":
      return "errored";
    default:
      return "idle";
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= MAX_TEXT ? flat : `${flat.slice(0, MAX_TEXT - 1)}…`;
}

/** What the thread's agent has been doing, what it waits on, and what it has queued, from its recent history. */
function readDetail(
  projection: OrchestrationV2ThreadProjection,
  shell: OrchestrationV2ThreadShell,
  updatedAt: number,
): ThreadDetail {
  const items = projection.turnItems.toSorted(
    (left, right) =>
      DateTime.toEpochMillis(left.updatedAt) - DateTime.toEpochMillis(right.updatedAt),
  );
  const activity = items.flatMap((item) => {
    const step = stepOf(item);
    return step === undefined
      ? []
      : [{ ...step, minutesAgo: 0, at: DateTime.toEpochMillis(item.updatedAt) }];
  });
  const touched = [
    ...new Set(
      items.flatMap((item) => (item.type === "file_change" ? [item.fileName] : [])).toReversed(),
    ),
  ].slice(0, 5);
  const lastAgentMessage = projection.messages.findLast(
    (message) => message.role === "assistant" && !message.streaming,
  )?.text;
  const messages = new Map(projection.messages.map((message) => [message.id, message.text]));
  const queued = projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
    )
    .flatMap((run) => {
      const text = messages.get(run.userMessageId);
      return text === undefined ? [] : [{ runId: run.id, text }];
    });
  const pending = pendingOf(items, shell);
  return {
    updatedAt,
    activity: activity.slice(-RECENT_STEPS),
    touched,
    ...(lastAgentMessage === undefined ? {} : { lastAgentMessage }),
    queued,
    ...(pending === undefined ? {} : { pending }),
  };
}

function pendingOf(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  shell: OrchestrationV2ThreadShell,
): ThreadDetail["pending"] {
  const request = shell.pendingRuntimeRequest;
  if (request === null) return undefined;
  const item = items.findLast(
    (candidate) =>
      (candidate.type === "approval_request" || candidate.type === "user_input_request") &&
      candidate.requestId === request.id,
  );
  if (item?.type === "user_input_request" || request.kind === "user_input") {
    const questions = item?.type === "user_input_request" ? item.questions : [];
    return {
      id: request.id,
      kind: "question",
      text: clip(
        questions.map((question) => question.question).join(" ") || "The agent has a question.",
      ),
      questionIds: questions.map((question) => question.id),
    };
  }
  const command = items.findLast(
    (candidate) => candidate.type === "command_execution" && candidate.status !== "completed",
  );
  const text =
    (item?.type === "approval_request" ? (item.prompt ?? item.title) : null) ??
    (command?.type === "command_execution" ? `Run \`${command.input}\`` : null) ??
    `Allow a ${request.kind.replace(/[-_]/gu, " ")} request`;
  return { id: request.id, kind: "approval", text: clip(text), questionIds: [] };
}

function stepOf(item: OrchestrationV2TurnItem): Step | undefined {
  switch (item.type) {
    case "file_change":
      return { kind: "edit", text: `Edited ${item.fileName}`, minutesAgo: 0 };
    case "command_execution":
      return {
        kind: /\b(test|vitest|jest|pytest|cargo test|go test)\b/u.test(item.input)
          ? "test"
          : "command",
        text: clip(`Ran ${item.input}`),
        minutesAgo: 0,
      };
    case "todo_list": {
      const current =
        item.steps.find((step) => step.status === "running") ??
        item.steps.find((step) => step.status === "pending");
      return current === undefined
        ? undefined
        : { kind: "plan", text: clip(current.text), minutesAgo: 0 };
    }
    case "assistant_message":
      return item.streaming || item.text.trim().length === 0
        ? undefined
        : { kind: "message", text: clip(item.text), minutesAgo: 0 };
    case "error":
      return { kind: "error", text: clip(item.title ?? "The agent hit an error."), minutesAgo: 0 };
    default:
      return undefined;
  }
}
