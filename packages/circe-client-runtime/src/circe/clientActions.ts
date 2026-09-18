import type { CirceClientToolCandidates, CirceClientToolName } from "@circe/contracts";

/**
 * The client half of the bounded tool layer. A server-authorized client
 * action names a tool, its revalidated arguments, and the acceptance speech
 * the node spoke. The origin client runs the matching executor and reports a
 * real result; a missing executor is a wiring failure, never a claim that the
 * user's device cannot do the thing (the tool would not have been offered).
 *
 * Platform packages (web, desktop, mobile) own the executor table. This seam
 * keeps lookup, argument shape, and failure reporting identical everywhere so
 * the same classified action resolves the same way on every client.
 */

export type CirceClientActionArgs = Readonly<Record<string, string | boolean>>;

export type CirceClientActionResult =
  | {
      readonly status: "ok";
      /** Real result speech; absent means use acceptance copy. */ readonly speech?: string;
    }
  | { readonly status: "failed"; readonly speech: string };

export type CirceClientActionExecutor = (
  args: CirceClientActionArgs,
) => CirceClientActionResult | Promise<CirceClientActionResult>;

/** Executors keyed by the tool name the node classified. */
export type CirceClientActionExecutors = Readonly<Record<string, CirceClientActionExecutor>>;

/**
 * Run one server-authorized client action. Never throws: a throwing executor
 * becomes a typed failure with the tool name, so a broken platform API can
 * never drop the turn.
 */
export async function runCirceClientAction(input: {
  readonly tool: string;
  readonly args: CirceClientActionArgs;
  readonly executors: CirceClientActionExecutors;
}): Promise<CirceClientActionResult> {
  const executor = input.executors[input.tool];
  if (executor === undefined) {
    return {
      status: "failed",
      speech: `The ${input.tool} action has no executor on this client.`,
    };
  }
  try {
    return await executor(input.args);
  } catch {
    return { status: "failed", speech: `The ${input.tool} action didn't finish.` };
  }
}

/** The speech for a finished action: the real result, else the acceptance copy. */
export function circeClientActionSpeech(input: {
  readonly acceptance: string;
  readonly result: CirceClientActionResult;
}): string {
  return input.result.status === "ok"
    ? (input.result.speech ?? input.acceptance)
    : input.result.speech;
}

/** Read a string argument, or undefined when absent/blank. */
export function circeClientActionTextArg(
  args: CirceClientActionArgs,
  name: string,
): string | undefined {
  const value = args[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Read a boolean argument, or undefined when absent. */
export function circeClientActionBooleanArg(
  args: CirceClientActionArgs,
  name: string,
): boolean | undefined {
  const value = args[name];
  return typeof value === "boolean" ? value : undefined;
}

/** A client's advertised capabilities and bounded candidate sets. */
export interface CirceClientActionCapabilities {
  readonly tools: ReadonlyArray<CirceClientToolName>;
  readonly candidates: CirceClientToolCandidates;
}
