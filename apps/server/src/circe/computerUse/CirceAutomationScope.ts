import { ProviderInstanceId, type EnvironmentId, type ThreadId } from "@circe/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { McpCapability, McpInvocationScope } from "../../mcp/McpInvocationContext.ts";

/**
 * A Circe-owned automation identity. The preview/desktop broker scopes every
 * request to a provider session, which a voice or text control turn is not.
 * This builds the equivalent scope for Circe itself: the synthetic session id
 * is stable for one control session, so the broker pins one desktop host for
 * that session exactly as it does for a provider, and drops it on
 * disconnect.
 */
export const CIRCE_AUTOMATION_CAPABILITIES: ReadonlySet<McpCapability> = new Set([
  "preview",
  "desktop-use",
]);

const CIRCE_CONTROL_INSTANCE = ProviderInstanceId.make("circe-control");

export interface CirceAutomationScopeInput {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Stable for the session so host stickiness survives multiple operations. */
  readonly controlSessionId: string;
}

export const circeAutomationScope = (
  input: CirceAutomationScopeInput,
): Effect.Effect<McpInvocationScope> =>
  Effect.map(Clock.currentTimeMillis, (issuedAt): McpInvocationScope => ({
    environmentId: input.environmentId,
    threadId: input.threadId,
    providerSessionId: `circe-control:${input.controlSessionId}`,
    providerInstanceId: CIRCE_CONTROL_INSTANCE,
    capabilities: CIRCE_AUTOMATION_CAPABILITIES,
    issuedAt,
  }));
