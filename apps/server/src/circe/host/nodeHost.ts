import {
  CIRCE_BOT_MESSAGE_MAX_CHARS,
  circeBotConversationId,
  circeBotIdOfPlace,
  CommandId,
  isChatWorkspace,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type CirceBotId,
  type CirceBotMessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@circe/contracts";
import { isExplicitSpokenApprovalAnswer } from "@circe/core/confirmation";
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
import { CirceBots } from "../Services/CirceBots.ts";
import { CirceComputerAccess } from "../Services/CirceComputerAccess.ts";
import { botProject, botThread } from "./botPlaces.ts";
import {
  computerProject,
  computerRequestOf,
  computerThreadId,
  computerThreads,
  isComputerPlace,
} from "./computerPlace.ts";
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

export interface NodeHostOptions {
  /**
   * The device session of the turn being carried out, when the caller knows
   * it. A spoken yes settles a request to use the computer only for the
   * session that was asked.
   */
  readonly turnOrigin?: () => string | null;
  /** The computer request the speaking device was showing during this turn. */
  readonly turnPresentedComputerRequest?: () => string | null;
  /**
   * Threads the turn being carried out started or gave work to. They read as
   * running until the caller clears this set after the turn and refreshes
   * circe-core: work that finished within the turn is then a change
   * circe-core sees and announces, rather than state already in the baseline
   * it compares against.
   */
  readonly heldThisTurn?: Set<string>;
  /**
   * Where the caller's turn stands. circe-core compares each snapshot with
   * the one it last saw and adopts its post-turn snapshot without comparing,
   * so anything that changed during a turn would never be announced. While a
   * turn runs (`turn`), every thread the turn did not touch reads as it was
   * when the turn began and a thread that appeared from elsewhere is hidden.
   * After it, `own` shows the turn's own threads as they really are while
   * the rest stay frozen, so their news is the asking device's; `open`
   * shows everything, and the rest is news for everyone.
   */
  readonly turnPhase?: () => {
    readonly phase: "turn" | "own" | "open";
    /** Which turn; a new one starts its own frozen world. */
    readonly turn: number;
  };
}

export const makeNodeHost = (options: NodeHostOptions = {}) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const projections = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const bots = yield* CirceBots;
    const computer = yield* CirceComputerAccess;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = yield* Effect.context<never>();
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseWith(context)(effect);

    const details = new Map<string, ThreadDetail>();
    /** How many conversations Circe has started with each bot since this node started. */
    const botConversations = new Map<string, number>();
    const conversationOf = (botId: string) =>
      circeBotConversationId(botId, botConversations.get(botId) ?? 0);
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
            !openIds.has(thread.id) &&
            thread.deletedAt === null &&
            projectIds.has(thread.projectId),
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
      // A gateway problem hides the bots from this turn; it never hides the
      // node's coding work.
      const botPlaces = yield* bots.places().pipe(
        Effect.catch((error) =>
          Effect.logWarning("Grok Bots left out of the Circe world", {
            reason: error.message,
          }).pipe(Effect.as([])),
        ),
      );
      const computerState = computer.controllable ? yield* computer.state : null;
      const { phase, turn } = options.turnPhase?.() ?? { phase: "open" as const, turn: 0 };
      const held = options.heldThisTurn ?? new Set<string>();
      // The turn's own work reads as running until the turn is over, so work
      // that finished inside it is still a change circe-core will see.
      const holding = (thread: Thread): Thread =>
        phase === "turn" &&
        held.has(thread.id) &&
        thread.pending === undefined &&
        thread.runState !== "running"
          ? { ...thread, runState: "running" }
          : thread;
      const live = [
        ...open.map((thread) => toThread(thread, detailById.get(thread.id), false, nowMs)),
        ...botPlaces.map((place) => botThread(place, nowMs, conversationOf(place.bot.botId))),
        ...(computerState === null ? [] : computerThreads(computerState, nowMs)),
        ...closed.map((thread) => toThread(thread, undefined, true, nowMs)),
      ].map(holding);
      const threads = phase === "open" ? opened(live) : frozen(live, held, turn);
      return {
        projects: [
          ...projects,
          ...botPlaces.map(botProject),
          ...(computerState === null ? [] : [computerProject]),
        ],
        threads,
        focus: {},
      } satisfies HostSnapshot;
    });

    /** The world as the turn began, apart from the threads the turn itself touched. */
    let turnStart: { readonly turn: number; readonly threads: ReadonlyArray<Thread> } | undefined;
    const opened = (live: ReadonlyArray<Thread>): Thread[] => {
      turnStart = undefined;
      return [...live];
    };
    const frozen = (
      live: ReadonlyArray<Thread>,
      own: ReadonlySet<string>,
      turn: number,
    ): Thread[] => {
      if (turnStart === undefined || turnStart.turn !== turn) {
        turnStart = { turn, threads: live };
        return [...live];
      }
      const before = new Map(turnStart.threads.map((thread) => [thread.id, thread]));
      const shown = live.flatMap((thread) =>
        own.has(thread.id) ? [thread] : before.has(thread.id) ? [before.get(thread.id)!] : [],
      );
      const liveIds = new Set(live.map((thread) => thread.id));
      return [
        ...shown,
        ...turnStart.threads.filter((thread) => !liveIds.has(thread.id) && !own.has(thread.id)),
      ];
    };

    const describeProject = (project: OrchestrationProjectShell) =>
      Effect.gen(function* () {
        // The node's chat space is where its agents answer general questions
        // with live data; Circe sends questions about nothing in the user's
        // projects there.
        if (isChatWorkspace(project)) {
          return {
            id: project.id,
            name: project.title,
            about: "General questions and requests that are not about a coding project.",
            general: true,
            kind: "general",
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
        lastActivityMinutesAgo: Math.max(
          0,
          (now - DateTime.toEpochMillis(shell.updatedAt)) / 60_000,
        ),
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

    /** Hand the words to the bot; a message the gateway did not take is a refusal. */
    const sendToBot = (botId: CirceBotId, text: string) =>
      Effect.gen(function* () {
        const message = yield* bots
          .send({
            botId,
            messageId: (yield* uuid) as CirceBotMessageId,
            text: text.trim().slice(0, CIRCE_BOT_MESSAGE_MAX_CHARS),
          })
          .pipe(Effect.mapError((error) => new CirceHostOperationError({ reason: error.message })));
        if (message.delivery === "failed" || message.delivery === "expired") {
          return yield* refuse(message.error ?? "the bot did not take the message");
        }
      });

    const turnOrigin = () => options.turnOrigin?.() ?? null;
    /** The device session that started each thread, so undo from another device is refused. */
    const startedBy = new Map<string, string | null>();
    const recordStart = (threadId: string) => {
      startedBy.set(threadId, turnOrigin());
      options.heldThisTurn?.add(threadId);
      const oldest = startedBy.keys().next();
      if (startedBy.size > 200 && oldest.done !== true) startedBy.delete(oldest.value);
      return threadId;
    };
    /** The device session that queued each message, for the same check on undo. */
    const queuedBy = new Map<string, string | null>();
    const queueKey = (threadId: string, text: string) => `${threadId}\u0000${text}`;
    /**
     * Refuses to take back what another device did; circe-core keeps one
     * memory per node, so its "last action" may be someone else's. When this
     * node cannot tell who did it, as after a restart, it refuses too.
     */
    const ownAction = (origin: string | null | undefined) => {
      const current = turnOrigin();
      if (current === null || origin === current) return Effect.void;
      return refuse(
        origin === undefined
          ? "I can't tell which device did that, so undo it from the device that did"
          : "that was done from another device; undo it there",
      );
    };
    const ownStart = (threadId: string) => ownAction(startedBy.get(threadId));
    const computerError = (error: { readonly reason: string }) =>
      new CirceHostOperationError({ reason: error.reason });

    /** Asks to use this computer for the user's words; nothing moves until the user approves. */
    const askForComputer = (text: string) =>
      computer.request({ goal: text, requester: { kind: "user", origin: turnOrigin() } }).pipe(
        Effect.mapError(computerError),
        Effect.map((request) => recordStart(computerThreadId(request.id))),
      );

    /**
     * Words for a request to use the computer. While it waits, an explicit yes
     * or no settles it for the device that was asked; anything else is a new
     * goal, which needs its own answer.
     */
    const answerComputer = (threadId: string, text: string) =>
      Effect.gen(function* () {
        const requestId = computerRequestOf(threadId);
        const waiting = (yield* computer.state).pending;
        const verdict = isExplicitSpokenApprovalAnswer(text);
        if (requestId !== null && waiting?.id === requestId && verdict !== undefined) {
          return yield* computer
            .decide(requestId, verdict === "accept" ? "approve" : "deny", {
              kind: "spoken",
              origin: turnOrigin(),
              presented: options.turnPresentedComputerRequest?.() ?? null,
            })
            .pipe(Effect.mapError(computerError));
        }
        yield* askForComputer(text);
      });

    /** What a bot cannot do, in the words Circe tells the user. */
    const botLimit = {
      respond: "Grok Bots don't ask Circe for approvals; answer the bot in Grok",
      stop: "Circe can't stop a Grok Bot; stop it in Grok, or choose Stop waiting on the bot's page",
      close: "a Grok Bot conversation can't be closed; clear it from the bot's page",
      withdraw: "a message already went to the Grok Bot and can't be taken back",
    } as const;

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
            const botId = circeBotIdOfPlace(projectId);
            // A new conversation with the bot is a new thread, which circe-core
            // then watches for the bot's answer.
            if (botId !== null) {
              yield* sendToBot(botId, text);
              botConversations.set(botId, (botConversations.get(botId) ?? 0) + 1);
              return conversationOf(botId);
            }
            if (isComputerPlace(projectId)) return yield* askForComputer(text);
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
          }).pipe(Effect.map(recordStart)),
        ),

      deliver: (threadId, text, delivery) =>
        run(
          Effect.gen(function* () {
            // Work given this turn is held as running until the turn ends, so
            // an answer that arrives before this returns is still news.
            options.heldThisTurn?.add(threadId);
            // A bot has one conversation and no queue: every delivery is a new message.
            const botId = circeBotIdOfPlace(threadId);
            if (botId !== null) {
              yield* sendToBot(botId, text);
              return;
            }
            if (isComputerPlace(threadId)) return yield* answerComputer(threadId, text);
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
              queuedBy.set(queueKey(shell.id, text), turnOrigin());
              const oldest = queuedBy.keys().next();
              if (queuedBy.size > 200 && oldest.done !== true) queuedBy.delete(oldest.value);
              return yield* send(shell.id, text, { type: "queue_after_active" });
            }
            return yield* send(shell.id, text, { type: "start_immediately" });
          }),
        ),

      respond: (threadId, requestId, decision) =>
        run(
          Effect.gen(function* () {
            options.heldThisTurn?.add(threadId);
            if (circeBotIdOfPlace(threadId) !== null) return yield* refuse(botLimit.respond);
            if (isComputerPlace(threadId)) {
              return yield* computer
                .decide(requestId, decision, {
                  kind: "spoken",
                  origin: turnOrigin(),
                  presented: options.turnPresentedComputerRequest?.() ?? null,
                })
                .pipe(Effect.mapError(computerError));
            }
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
            if (circeBotIdOfPlace(threadId) !== null) return yield* refuse(botLimit.stop);
            if (isComputerPlace(threadId)) {
              yield* computer.stop(computerRequestOf(threadId) ?? undefined);
              return;
            }
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
            yield* ownStart(threadId);
            if (circeBotIdOfPlace(threadId) !== null) return yield* refuse(botLimit.close);
            // Taking back a request to use the computer withdraws or stops it.
            if (isComputerPlace(threadId)) {
              yield* computer.stop(computerRequestOf(threadId) ?? undefined);
              return;
            }
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
            yield* ownAction(queuedBy.get(queueKey(threadId, text)));
            if (circeBotIdOfPlace(threadId) !== null) return yield* refuse(botLimit.withdraw);
            if (isComputerPlace(threadId)) return yield* refuse("the computer keeps no queue");
            const shell = yield* threadShell(threadId);
            details.delete(shell.id);
            const queued = (yield* detailFor(shell)).queued.findLast(
              (entry) => entry.text === text,
            );
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
