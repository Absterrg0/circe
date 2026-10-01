import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The desktop host protocol carries computer-use work between the server and
 * the Electron process that owns the Cua runtime and the OS session. The host
 * holds no policy: it validates the caller capability, relays calls to the
 * driver, tracks in-flight work, and reports runtime state. The server decides
 * what may run, under which mission, and what is recorded.
 */

export const COMPUTER_HOST_PROTOCOL_VERSION = 1;

export const ComputerHostPlatform = Schema.Literals(["darwin", "linux", "win32", "other"]);
export type ComputerHostPlatform = typeof ComputerHostPlatform.Type;

/**
 * Read-only driver tools. They observe the desktop without dispatching input.
 * `parse_visual_regions` reads an existing driver-owned capture and never
 * sends input; it is a read even though it runs the perception worker.
 */
export const COMPUTER_HOST_READ_TOOLS = [
  "check_permissions",
  "extension_status",
  "get_accessibility_tree",
  "get_cursor_position",
  "get_desktop_state",
  "get_screen_size",
  "get_session_state",
  "get_window_state",
  "list_apps",
  "list_windows",
  "parse_visual_regions",
] as const;

/**
 * Mutating driver tools. Every one of them requires an active mission and is
 * fenced by input interruption.
 */
export const COMPUTER_HOST_MUTATION_TOOLS = [
  "bring_to_front",
  "click",
  "double_click",
  "drag",
  "hotkey",
  "invoke_menu",
  "kill_app",
  "launch_app",
  "move_cursor",
  "press_key",
  "scroll",
  "set_value",
  "set_window_frame",
  "type_text",
] as const;

export const ComputerHostToolName = Schema.Literals([
  ...COMPUTER_HOST_READ_TOOLS,
  ...COMPUTER_HOST_MUTATION_TOOLS,
]);
export type ComputerHostToolName = typeof ComputerHostToolName.Type;

const COMPUTER_HOST_MUTATION_TOOL_SET: ReadonlySet<string> = new Set(COMPUTER_HOST_MUTATION_TOOLS);

export function computerHostToolIsMutation(tool: string): boolean {
  return COMPUTER_HOST_MUTATION_TOOL_SET.has(tool);
}

export const ComputerHostEffect = Schema.Literals([
  /** The action ran and its postcondition was observed. */
  "verified",
  /** Input may have been delivered; the result cannot be classified. Never replayed. */
  "dispatched-unknown",
  /** The action was refused or failed before any input was sent. */
  "not-dispatched",
  /** A policy or capability refusal with a stable code. */
  "refused",
]);
export type ComputerHostEffect = typeof ComputerHostEffect.Type;

export const ComputerHostRefusalCode = Schema.Literals([
  "mission-required",
  "mission-mismatch",
  "mission-ended",
  "tool-not-allowed",
  "input-interrupted",
  "driver-unavailable",
  "driver-refused",
  "capability-required",
  "timeout",
  "host-shutdown",
  "internal-error",
]);
export type ComputerHostRefusalCode = typeof ComputerHostRefusalCode.Type;

export const ComputerHostImage = Schema.Struct({
  mimeType: Schema.String,
  dataBase64: Schema.String,
});
export type ComputerHostImage = typeof ComputerHostImage.Type;

/**
 * The driver result after the host normalizes it. `structured` is the driver's
 * structured payload when it parses as JSON; `text` is always present.
 */
export const ComputerHostToolResult = Schema.Struct({
  isError: Schema.Boolean,
  degraded: Schema.Boolean,
  effect: ComputerHostEffect,
  text: Schema.String,
  refusalCode: Schema.optional(ComputerHostRefusalCode),
  /**
   * The driver's own stable error code, such as `capture_expired` or
   * `stale_element_token`, when it reported one. `refusalCode` is the host's
   * coarse class; this is what decides whether reobserving can help.
   */
  driverCode: Schema.optional(Schema.String),
  structured: Schema.optional(Schema.Unknown),
  images: Schema.Array(ComputerHostImage),
});
export type ComputerHostToolResult = typeof ComputerHostToolResult.Type;

export const ComputerHostHello = Schema.Struct({
  kind: Schema.Literal("hello"),
  protocol: Schema.Literal(COMPUTER_HOST_PROTOCOL_VERSION),
  capability: Schema.String,
  pid: Schema.Int,
  platform: ComputerHostPlatform,
  appVersion: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerHostHello = typeof ComputerHostHello.Type;

export const ComputerHostRequestMethod = Schema.Literals([
  "status",
  "begin-mission",
  "call",
  "stop",
  "end-mission",
]);
export type ComputerHostRequestMethod = typeof ComputerHostRequestMethod.Type;

export const ComputerHostRequest = Schema.Struct({
  kind: Schema.Literal("request"),
  protocol: Schema.Literal(COMPUTER_HOST_PROTOCOL_VERSION),
  id: TrimmedNonEmptyString,
  method: ComputerHostRequestMethod,
  missionId: Schema.optional(TrimmedNonEmptyString),
  tool: Schema.optional(TrimmedNonEmptyString),
  args: Schema.optional(Schema.Unknown),
  reason: Schema.optional(TrimmedNonEmptyString),
  /**
   * How long the caller will wait. The host fences the call at dequeue when
   * the deadline has passed, so a timed-out request cannot execute later.
   */
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type ComputerHostRequest = typeof ComputerHostRequest.Type;

export const ComputerHostErrorCode = Schema.Literals([
  "unsupported-method",
  "invalid-request",
  "capability-required",
  "driver-unavailable",
  "driver-exit",
  "mission-conflict",
  "internal-error",
]);
export type ComputerHostErrorCode = typeof ComputerHostErrorCode.Type;

export const ComputerHostError = Schema.Struct({
  code: ComputerHostErrorCode,
  message: Schema.String,
});
export type ComputerHostError = typeof ComputerHostError.Type;

export const ComputerHostReply = Schema.Struct({
  kind: Schema.Literal("reply"),
  id: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(ComputerHostError),
});
export type ComputerHostReply = typeof ComputerHostReply.Type;

export const ComputerHostEventKind = Schema.Literals([
  /** Stop, physical Escape, lock/sleep, or permission loss interrupted input. */
  "input-interrupted",
  /** The driver runtime exited; every mission is over until a fresh start. */
  "driver-exit",
  /** Runtime lifecycle: stopped, starting, ready, failed. */
  "runtime-state",
  /** OS permission state changed. */
  "permission-changed",
]);
export type ComputerHostEventKind = typeof ComputerHostEventKind.Type;

export const ComputerHostEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  protocol: Schema.Literal(COMPUTER_HOST_PROTOCOL_VERSION),
  event: ComputerHostEventKind,
  missionId: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerHostEvent = typeof ComputerHostEvent.Type;

export const ComputerHostRuntimeState = Schema.Literals(["stopped", "starting", "ready", "failed"]);
export type ComputerHostRuntimeState = typeof ComputerHostRuntimeState.Type;

export const ComputerHostCapabilities = Schema.Struct({
  observe: Schema.Boolean,
  capture: Schema.Boolean,
  pointer: Schema.Boolean,
  keyboard: Schema.Boolean,
  windows: Schema.Boolean,
  browser: Schema.Boolean,
  /** Accessibility elements can be targeted by their driver token. */
  nativeGrounding: Schema.Boolean,
  /**
   * The driver advertises capture-bound clicks and visual region parsing, and
   * its perception extension is installed and healthy. Both halves are
   * required: regions without capture-bound clicks cannot be acted on.
   */
  visualGrounding: Schema.Boolean,
});
export type ComputerHostCapabilities = typeof ComputerHostCapabilities.Type;

export const ComputerHostStatus = Schema.Struct({
  /**
   * A graphical session exists and the runtime has not failed. This says a
   * call can be attempted, not that a permission or route was proven.
   */
  available: Schema.Boolean,
  platform: ComputerHostPlatform,
  sessionType: Schema.optional(Schema.Literals(["wayland", "x11", "unknown"])),
  runtime: ComputerHostRuntimeState,
  driverVersion: Schema.optional(TrimmedNonEmptyString),
  driverPid: Schema.optional(Schema.Int),
  /** Driver-reported route and permission facts, when a probe succeeded. */
  permissions: Schema.optional(Schema.Unknown),
  reason: Schema.optional(TrimmedNonEmptyString),
  /** Why visual grounding is off while the computer is otherwise usable. */
  visualReason: Schema.optional(TrimmedNonEmptyString),
  capabilities: ComputerHostCapabilities,
});
export type ComputerHostStatus = typeof ComputerHostStatus.Type;

/**
 * The endpoint and one-time capability the desktop app passes to its local
 * server in the bootstrap envelope. The server connects as a guest; the host
 * refuses every caller that does not present the capability.
 */
export const ComputerHostBootstrap = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  capability: Schema.String,
  pid: Schema.Int,
});
export type ComputerHostBootstrap = typeof ComputerHostBootstrap.Type;
