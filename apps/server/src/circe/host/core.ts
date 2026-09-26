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
  /** Not a codebase: where general questions go. At most one. */
  readonly general?: boolean;
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
}

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
      createCirce: (options) =>
        new core.Circe({
          host: options.host,
          jev: options.jev,
          store: core.fileMemory(options.memoryFile),
          logFile: options.logFile,
        }),
      JevTimeoutError: core.JevTimeoutError,
      httpJev: core.httpJev,
    };
  } catch {
    return undefined;
  }
}
