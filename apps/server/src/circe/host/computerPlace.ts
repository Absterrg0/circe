import type {
  CirceComputerAccessState,
  CirceComputerRequest,
} from "../Services/CirceComputerAccess.ts";
import type { Project, Thread } from "./core.ts";

/**
 * This node's computer in circe-core's world. The computer is a project work
 * can go to, and each request to use it is its own thread, so circe-core sees
 * the thread a start created: undo closes that request, and it watches that
 * request until it finishes.
 *
 * A waiting request is a question, not an approval. circe-core settles
 * approvals on its own under the user's standing rules, and using the
 * computer always needs the user's own answer: the host reads that answer
 * itself, where a yes settles only the request the user's device was asked.
 *
 * The ids never collide with orchestration ids, and the host routes every
 * operation on them to computer access.
 */
export const COMPUTER_PLACE_ID = "computer:this";
const REQUEST_PREFIX = "computer:request:";

export const computerThreadId = (requestId: string) => `${REQUEST_PREFIX}${requestId}`;

/** The request a thread id names, or null for the place itself and any other id. */
export const computerRequestOf = (id: string | undefined): string | null =>
  id !== undefined && id.startsWith(REQUEST_PREFIX) && id.length > REQUEST_PREFIX.length
    ? id.slice(REQUEST_PREFIX.length)
    : null;

export const isComputerPlace = (id: string | undefined) =>
  id === COMPUTER_PLACE_ID || computerRequestOf(id) !== null;

const MAX_TEXT = 300;
const TITLE = "This computer";

export const computerProject: Project = {
  id: COMPUTER_PLACE_ID,
  name: TITLE,
  about:
    "Not a codebase: the desktop of the computer Circe runs on. Opens apps, the web browser and websites, and clicks, types and reads what is on screen for the user.",
};

/** The requests circe-core should see: the latest settled one, and the one waiting or running. */
export function computerThreads(state: CirceComputerAccessState, nowMs: number): Thread[] {
  const { pending, active, last } = state;
  const threads: Thread[] = [];
  const current = active ?? pending;
  if (last !== null && last.request.id !== current?.id) {
    threads.push({
      ...base(last.request, last.at, nowMs),
      runState: last.outcome === "failed" || last.outcome === "uncertain" ? "errored" : "idle",
      lastAgentMessage: clip(last.message),
    });
  }
  if (active !== null) {
    threads.push({ ...base(active, active.startedAt, nowMs), runState: "running" });
  } else if (pending !== null) {
    threads.push({
      ...base(pending, pending.at, nowMs),
      runState: "idle",
      pending: { id: pending.id, kind: "question", text: clip(approvalQuestion(pending)) },
    });
  }
  return threads;
}

function base(request: CirceComputerRequest, at: string, nowMs: number) {
  const atMs = Date.parse(at);
  return {
    id: computerThreadId(request.id),
    projectId: COMPUTER_PLACE_ID,
    title: TITLE,
    lastActivityMinutesAgo: Number.isNaN(atMs) ? 0 : Math.max(0, (nowMs - atMs) / 60_000),
    task: clip(request.goal),
    lastUserMessage: clip(request.goal),
    queued: [],
  };
}

/** What the user is asked; the same words on every device and in the reply. */
export function approvalQuestion(request: CirceComputerRequest): string {
  return request.requester.kind === "agent"
    ? `"${request.requester.title}" wants to use this computer for "${request.goal}". Say yes to allow it.`
    : `Use this computer for "${request.goal}"? Say yes to start.`;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= MAX_TEXT ? flat : `${flat.slice(0, MAX_TEXT - 1)}…`;
}
