import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The browser connector protocol between the Chrome extension, the native
 * messaging host, and the Circe node. The extension runs in the user's real
 * Chrome profile; the node never dials a public debugging port. The host
 * relays frames over authenticated local IPC, and the node treats every
 * observation and action as scoped to one attached tab.
 */

export const CirceBrowserConnectorTab = Schema.Struct({
  tabId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  active: Schema.Boolean,
  windowId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type CirceBrowserConnectorTab = typeof CirceBrowserConnectorTab.Type;

export const CirceBrowserConnectorElement = Schema.Struct({
  /** Stable connector handle: `ax:<backendNodeId>` or `css:<selector>`. */
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  role: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
  name: Schema.String.check(Schema.isMaxLength(200)),
  editable: Schema.Boolean,
  /** Current field or display text, when the accessibility node exposes it. */
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(400))),
  /** Compact state names such as checked, selected, expanded, focused. */
  state: Schema.optional(Schema.String.check(Schema.isMaxLength(160))),
  bounds: Schema.optional(
    Schema.Struct({
      x: Schema.Finite,
      y: Schema.Finite,
      width: Schema.Finite,
      height: Schema.Finite,
    }),
  ),
});
export type CirceBrowserConnectorElement = typeof CirceBrowserConnectorElement.Type;

export const CirceBrowserConnectorSnapshot = Schema.Struct({
  tabId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  url: Schema.String.check(Schema.isMaxLength(2_048)),
  visibleText: Schema.String.check(Schema.isMaxLength(8_000)),
  elements: Schema.Array(CirceBrowserConnectorElement).check(Schema.isMaxLength(200)),
});
export type CirceBrowserConnectorSnapshot = typeof CirceBrowserConnectorSnapshot.Type;

/**
 * One grounded operation. Locators are opaque to the node: they are handles
 * the extension itself produced, so a stale handle is refused by the
 * extension rather than turned into a blind click.
 */
export const CirceBrowserConnectorAction = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("click"),
    locator: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  }),
  Schema.Struct({
    operation: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(4_096)),
    locator: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  }),
  Schema.Struct({
    operation: Schema.Literal("press"),
    key: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    operation: Schema.Literal("navigate"),
    url: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  }),
  Schema.Struct({
    operation: Schema.Literal("scroll"),
    deltaX: Schema.optional(Schema.Finite),
    deltaY: Schema.optional(Schema.Finite),
  }),
]);
export type CirceBrowserConnectorAction = typeof CirceBrowserConnectorAction.Type;

/**
 * Frames are bidirectional. Requests carry an `id` the peer echoes; the node
 * correlates one response to one request and never applies an unmatched
 * result.
 */
export const CirceBrowserConnectorRequest = Schema.Union([
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("tab.list"),
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("tab.attach"),
    tabId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("tab.detach"),
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("snapshot"),
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("action"),
    action: CirceBrowserConnectorAction,
  }),
]);
export type CirceBrowserConnectorRequest = typeof CirceBrowserConnectorRequest.Type;

export const CirceBrowserConnectorResponse = Schema.Union([
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("tab.list.result"),
    tabs: Schema.Array(CirceBrowserConnectorTab).check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("tab.attach.result"),
    tabId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    profileLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("tab.detach.result"),
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("snapshot.result"),
    snapshot: CirceBrowserConnectorSnapshot,
  }),
  Schema.Struct({
    id: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    type: Schema.Literal("action.result"),
    ok: Schema.Boolean,
    detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
  }),
  Schema.Struct({
    id: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
    type: Schema.Literal("error"),
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(400)),
  }),
]);
export type CirceBrowserConnectorResponse = typeof CirceBrowserConnectorResponse.Type;

/** First frame the host sends after reading the node's connector token file. */
export const CirceBrowserConnectorHello = Schema.Struct({
  type: Schema.Literal("hello"),
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  extensionVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  instanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  profileLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
});
export type CirceBrowserConnectorHello = typeof CirceBrowserConnectorHello.Type;

export const CirceBrowserConnectorHelloResult = Schema.Struct({
  type: Schema.Literal("hello.result"),
  ok: Schema.Boolean,
  nodeId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  message: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
});
export type CirceBrowserConnectorHelloResult = typeof CirceBrowserConnectorHelloResult.Type;

/** Observed connector state for the node's readiness report. */
export const CirceBrowserConnectorStatus = Schema.Struct({
  connected: Schema.Boolean,
  instanceId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  profileLabel: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  attachedTabId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  attachedTabTitle: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  attachedTabUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  lastSeenAtMs: Schema.optional(NonNegativeInt),
  /** Why the connector is unavailable, when the listener could not start. */
  detail: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400))),
});
export type CirceBrowserConnectorStatus = typeof CirceBrowserConnectorStatus.Type;
