/**
 * What this server uses from circe-core (`@absterrg0/circe-core`), Circe's
 * private interpretation core. Public checkouts build and run without it: it
 * is fetched on install only when a token can read it
 * (scripts/fetch-circe-core.mjs), and without it the Circe host layer is off.
 * When it is installed, the calls into it are checked against its own types,
 * so these cannot drift from it unnoticed.
 */

export interface Focus {
  readonly threadId?: string;
  readonly projectId?: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  /** One line describing what the project is. */
  readonly about: string;
  readonly areas?: ReadonlyArray<string>;
  /** Not a codebase: where general questions go. At most one. Read by cores before 0.3. */
  readonly general?: boolean;
  /** What this is when not a codebase; cores from 0.3 read this instead of `general`. */
  readonly kind?: "codebase" | "general" | "place";
  /** For a place: what starting work there does, such as "use this computer". */
  readonly action?: string;
}

export interface PendingRequest {
  readonly id: string;
  readonly kind: "approval" | "question";
  readonly text: string;
}

export interface Step {
  readonly kind: "plan" | "edit" | "command" | "test" | "message" | "error";
  readonly text: string;
  readonly minutesAgo: number;
}

export interface Thread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly runState: "running" | "idle" | "errored";
  readonly pending?: PendingRequest;
  readonly lastActivityMinutesAgo: number;
  readonly task: string;
  readonly lastUserMessage?: string;
  readonly lastAgentMessage?: string;
  readonly queued: ReadonlyArray<string>;
  /** Oldest first. */
  readonly activity?: ReadonlyArray<Step>;
  /** Newest first. */
  readonly touched?: ReadonlyArray<string>;
  readonly archived?: boolean;
}

export interface HostSnapshot {
  readonly projects: ReadonlyArray<Project>;
  readonly threads: ReadonlyArray<Thread>;
  readonly focus: Focus;
}

export type Delivery =
  | { readonly mode: "send" }
  | { readonly mode: "queue" }
  | { readonly mode: "steer" }
  | { readonly mode: "reply"; readonly requestId: string };

/** What a host implements; operations throw when the host cannot carry them out. */
export interface CirceHost {
  state(): Promise<HostSnapshot> | HostSnapshot;
  start(projectId: string, text: string): Promise<string>;
  deliver(threadId: string, text: string, delivery: Delivery): Promise<void>;
  respond(threadId: string, requestId: string, decision: "approve" | "deny"): Promise<void>;
  stop(threadId: string): Promise<void>;
  open?(focus: Focus): Promise<void>;
  close?(threadId: string): Promise<void>;
  withdraw?(threadId: string, text: string): Promise<void>;
}

/** TypeSafe System One wire types. */
export interface JevRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, { readonly type: "choice" | "noul" | "score" }>>;
}

export type Answer =
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | { readonly type: "noul"; readonly noul: number };

export interface JevResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  readonly latencyMs: number;
  readonly cached: boolean;
}

export interface Jev {
  ask(request: JevRequest): Promise<JevResponse>;
}

export interface Reply {
  readonly said: string;
  readonly status: "acted" | "asked" | "failed";
  readonly options?: ReadonlyArray<string>;
  readonly navigate?: Focus;
  readonly started: ReadonlyArray<string>;
}

export interface Circe {
  say(utterance: string, options?: { readonly focus?: Focus }): Promise<Reply>;
  refresh(): Promise<ReadonlyArray<string>>;
  onNotice(listener: (notice: string) => void): () => void;
}

/**
 * Carrying out a goal on this node's desktop (circe-core 0.4 and later). The
 * host supplies observation and input; circe-core plans with the planner,
 * grounds each step against a fresh observation and has Jev choose among
 * the grounded candidates.
 */
export interface DesktopHost {
  apps(): Promise<ReadonlyArray<DesktopApp>>;
  launch(app: DesktopApp): Promise<DesktopLaunch>;
  observe(window: DesktopWindow, options?: { readonly closer?: boolean }): Promise<DesktopView>;
  act(view: DesktopView, action: DesktopAction): Promise<DesktopReceipt>;
}

export interface DesktopWindow {
  readonly id: string;
  readonly app: string;
  readonly title: string;
}

export interface DesktopApp {
  readonly id: string;
  readonly name: string;
  readonly running: boolean;
  readonly windows: ReadonlyArray<DesktopWindow>;
}

export interface DesktopLaunch {
  readonly receipt: DesktopReceipt;
  readonly window?: DesktopWindow;
}

export interface DesktopControl {
  readonly id: string;
  readonly role: string | null;
  readonly name: string;
  readonly description?: string;
  readonly value?: string;
  readonly state?: string;
  readonly source: "native" | "visual";
  readonly editable?: boolean;
}

export interface DesktopView {
  readonly window: DesktopWindow;
  readonly ref: string;
  readonly title: string;
  readonly controls: ReadonlyArray<DesktopControl>;
  readonly text?: ReadonlyArray<string>;
  readonly partial?: boolean;
}

export type DesktopKey =
  | "enter"
  | "tab"
  | "escape"
  | "backspace"
  | "arrowup"
  | "arrowdown"
  | "arrowleft"
  | "arrowright"
  | "pageup"
  | "pagedown";

export type DesktopAction =
  | { readonly kind: "click"; readonly control: string }
  | { readonly kind: "type"; readonly control: string; readonly text: string }
  | { readonly kind: "key"; readonly control: string; readonly key: DesktopKey }
  | { readonly kind: "scroll"; readonly direction: "up" | "down" | "left" | "right" };

export interface DesktopReceipt {
  readonly delivery: "confirmed" | "delivered" | "not-delivered" | "unknown";
  readonly detail?: string;
}

export interface DesktopPlanner {
  plan(request: { readonly prompt: string; readonly signal?: AbortSignal }): Promise<unknown>;
}

export interface DesktopProgress {
  readonly phase: "planning" | "opening" | "acting" | "verifying";
  readonly text: string;
}

export interface DesktopGoalOptions {
  readonly goal: string;
  readonly host: DesktopHost;
  readonly jev: Jev;
  readonly planner?: DesktopPlanner;
  readonly plan?: unknown;
  readonly app?: string;
  readonly text?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DesktopProgress) => void;
  readonly limits?: {
    readonly plans?: number;
    readonly actions?: number;
    readonly jevCalls?: number;
  };
}

interface Timed {
  readonly calls: number;
  readonly ms: number;
}

export interface DesktopOutcome {
  readonly status:
    | "done"
    | "unverified"
    | "uncertain"
    | "cancelled"
    | "refused"
    | "clarify"
    | "unsupported"
    | "unavailable";
  readonly said: string;
  readonly evidence?: string;
  readonly actions: number;
  readonly metrics: {
    readonly totalMs: number;
    readonly planner: Timed;
    readonly jev: Timed;
    readonly launch: Timed;
    readonly observe: Timed;
    readonly act: Timed;
    readonly verify: Timed;
  };
  readonly trace: ReadonlyArray<{
    readonly atMs: number;
    readonly kind: string;
    readonly detail: string;
  }>;
}

export interface CirceCore {
  /** One Circe in front of `host`, remembering across restarts in `memoryFile`. */
  readonly createCirce: (options: {
    readonly host: CirceHost;
    readonly jev: Jev;
    readonly memoryFile: string;
    readonly logFile: string;
  }) => Circe;
  readonly JevTimeoutError: new (message?: string) => Error;
  readonly httpJev: () => Jev;
  /** Absent from cores before 0.4; desktop goals then use the node's own step loop. */
  readonly runDesktopGoal: ((options: DesktopGoalOptions) => Promise<DesktopOutcome>) | undefined;
}

const noticeText = (notice: string | { readonly text: string }): string =>
  typeof notice === "string" ? notice : notice.text;

/**
 * The installed core, or undefined when this checkout does not have it. With
 * it installed, everything passed to it here is checked against its own types.
 */
export async function loadCirceCore(): Promise<CirceCore | undefined> {
  try {
    const core = await import(
      // @ts-ignore -- absent from public checkouts; the import then fails and the layer is off
      "@absterrg0/circe-core"
    );
    return {
      createCirce: (options) => {
        const circe = new core.Circe({
          host: options.host,
          jev: options.jev,
          store: core.fileMemory(options.memoryFile),
          logFile: options.logFile,
        });
        // Cores from 0.2 report notices as objects; this server speaks their text.
        return {
          say: (utterance, sayOptions) => circe.say(utterance, sayOptions),
          refresh: async () => (await circe.refresh()).map(noticeText),
          onNotice: (listener) => circe.onNotice((notice) => listener(noticeText(notice))),
        };
      },
      JevTimeoutError: core.JevTimeoutError,
      httpJev: core.httpJev,
      runDesktopGoal:
        "runDesktopGoal" in core
          ? (options: DesktopGoalOptions): Promise<DesktopOutcome> => core.runDesktopGoal(options)
          : undefined,
    };
  } catch {
    return undefined;
  }
}
