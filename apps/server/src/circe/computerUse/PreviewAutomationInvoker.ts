import type {
  BrowserAutomationInvoker,
  BrowserAutomationSnapshot,
} from "@circe/core/browserUseRuntime";
import type { BrowserAutomationOperation } from "@circe/core/browserUse";
import type {
  PreviewAutomationError,
  PreviewAutomationSnapshot,
  PreviewTabId,
} from "@circe/contracts";
import * as Effect from "effect/Effect";

import type * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";

/**
 * Backs the browser TypeSafe loop with the previewAutomation broker. Perception
 * is a grounded snapshot and automation is one selector-targeted operation,
 * both routed to this node's connected desktop host through the Circe-owned
 * automation scope. The loop never sees the broker, and the broker never sees
 * the goal.
 */
export interface PreviewAutomationInvoke {
  <A = unknown>(request: {
    readonly scope: McpInvocationScope;
    readonly operation: PreviewAutomationBroker.PreviewAutomationInvokeInput["operation"];
    readonly input: unknown;
    readonly tabId?: PreviewTabId;
    readonly timeoutMs?: number;
  }): Effect.Effect<A, PreviewAutomationError>;
}

export interface PreviewAutomationInvokerInput {
  readonly invoke: PreviewAutomationInvoke;
  readonly scope: McpInvocationScope;
  readonly tabId?: PreviewTabId;
  /** Non-zero settle for a wait action; a no-op leaves the loop pulsing fast. */
  readonly waitMs?: number;
}

export const makePreviewAutomationInvoker = (
  input: PreviewAutomationInvokerInput,
): BrowserAutomationInvoker<PreviewAutomationError> => {
  const target = input.tabId === undefined ? {} : { tabId: input.tabId };
  const waitMs = input.waitMs;
  const invoke = <A>(
    operation: PreviewAutomationBroker.PreviewAutomationInvokeInput["operation"],
    requestInput: unknown,
  ) => input.invoke<A>({ scope: input.scope, operation, input: requestInput, ...target });
  return {
    snapshot: () =>
      invoke<PreviewAutomationSnapshot>("snapshot", {}).pipe(
        Effect.map((snapshot): BrowserAutomationSnapshot => ({
          title: snapshot.title,
          url: snapshot.url,
          visibleText: snapshot.visibleText,
          interactiveElements: snapshot.interactiveElements,
        })),
      ),
    apply: (operation: BrowserAutomationOperation) =>
      invoke<void>(operation.operation, operation.input).pipe(Effect.asVoid),
    ...(waitMs === undefined ? {} : { wait: () => Effect.sleep(waitMs) }),
  };
};
