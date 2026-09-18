import * as Effect from "effect/Effect";

import { findCirceTool, type CirceToolArguments } from "./controlTools.ts";

/**
 * The dispatcher seam. Node tools run on the node; client tools never reach
 * here. Each node tool has exactly one executor keyed by the tool name, so a
 * bounded request has a single execution owner instead of a per-entry-point
 * path.
 *
 * Executors are code, not models: a lookup returns grounded data and the
 * speech that reports it. A missing executor is a wiring bug, not a user
 * refusal, so it reports failure with the tool name rather than telling the
 * user "not on this device."
 */

export type CirceToolExecution =
  | { readonly status: "ok"; readonly speech: string; readonly data?: unknown }
  | {
      readonly status: "needs-input";
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
    }
  | { readonly status: "failed"; readonly speech: string };

export interface CirceNodeToolRequest {
  readonly toolName: string;
  readonly args: CirceToolArguments;
  readonly source: string;
}

export type CirceNodeToolExecutor = (request: CirceNodeToolRequest) => Effect.Effect<CirceToolExecution>;

export type CirceNodeToolExecutors = Readonly<Record<string, CirceNodeToolExecutor>>;

export const runCirceNodeTool = (input: {
  readonly request: CirceNodeToolRequest;
  readonly executors: CirceNodeToolExecutors;
}): Effect.Effect<CirceToolExecution> =>
  Effect.gen(function* () {
    const tool = findCirceTool(input.request.toolName);
    if (tool === undefined || tool.host !== "node") {
      return {
        status: "failed",
        speech: `No node tool is registered as ${input.request.toolName}.`,
      } satisfies CirceToolExecution;
    }
    const executor = input.executors[tool.name];
    if (executor === undefined) {
      return {
        status: "failed",
        speech: `The ${tool.name} tool has no executor on this node.`,
      } satisfies CirceToolExecution;
    }
    return yield* executor(input.request);
  });
