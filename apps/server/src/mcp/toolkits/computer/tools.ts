import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@circe/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { ComputerService } from "../../../computer/ComputerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Provider-facing computer tools. The desktop host owns the OS session; this
 * surface is only a window into ComputerService, which enforces the active
 * mission. A model can never start, widen, or renew a mission here: tools
 * refuse with `mission-required` until the user starts one from the app or
 * voice lane, and every call is audited by the service.
 */

const dependencies = [McpInvocationContext.McpInvocationContext, ComputerService];

const Coordinate = Schema.Finite;

export const ComputerStatusResult = Schema.Struct({
  available: Schema.Boolean,
  platform: Schema.optional(TrimmedNonEmptyString),
  runtime: Schema.optional(TrimmedNonEmptyString),
  reason: Schema.optional(TrimmedNonEmptyString),
  missionActive: Schema.Boolean,
  capabilities: Schema.optional(
    Schema.Struct({
      observe: Schema.Boolean,
      capture: Schema.Boolean,
      pointer: Schema.Boolean,
      keyboard: Schema.Boolean,
      windows: Schema.Boolean,
    }),
  ),
});
export type ComputerStatusResult = typeof ComputerStatusResult.Type;

export const ComputerApp = Schema.Struct({
  name: TrimmedNonEmptyString,
  pid: Schema.optional(Schema.Int),
  running: Schema.Boolean,
  active: Schema.optional(Schema.Boolean),
});
export type ComputerApp = typeof ComputerApp.Type;

export const ComputerWindow = Schema.Struct({
  windowId: Schema.Int,
  pid: Schema.Int,
  appName: TrimmedNonEmptyString,
  title: Schema.String,
  onScreen: Schema.Boolean,
  bounds: Schema.optional(
    Schema.Struct({
      x: Schema.Finite,
      y: Schema.Finite,
      width: Schema.Finite,
      height: Schema.Finite,
    }),
  ),
});
export type ComputerWindow = typeof ComputerWindow.Type;

export const ComputerElement = Schema.Struct({
  token: TrimmedNonEmptyString,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  value: Schema.optional(Schema.String),
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type ComputerElement = typeof ComputerElement.Type;

export const ComputerActionResult = Schema.Struct({
  ok: Schema.Boolean,
  effect: TrimmedNonEmptyString,
  text: Schema.String,
  refusalCode: Schema.optional(TrimmedNonEmptyString),
});
export type ComputerActionResult = typeof ComputerActionResult.Type;

export const ComputerToolError = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: Schema.String,
});
export type ComputerToolError = typeof ComputerToolError.Type;

export const ComputerToolFailure = Schema.Union([ComputerToolError, McpCapabilityUnavailableError]);

export const ComputerStatusTool = Tool.make("computer_status", {
  description:
    "Report whether this node can drive its own desktop and whether a computer mission is active for this session. Call this first; every action tool refuses unless a mission is delegated to this exact session.",
  success: ComputerStatusResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read computer status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerListAppsTool = Tool.make("computer_list_apps", {
  description:
    "List applications on this node's desktop with pid and running state. Requires an active computer mission.",
  success: Schema.Struct({ apps: Schema.Array(ComputerApp) }),
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List desktop applications")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerListWindowsTool = Tool.make("computer_list_windows", {
  description:
    "List on-screen windows with pid, window id, application, title, and bounds. Requires an active computer mission.",
  parameters: Schema.Struct({
    pid: Schema.optional(Schema.Int.annotate({ description: "Restrict to one application." })),
    all: Schema.optional(
      Schema.Boolean.annotate({ description: "Include windows that are not on screen." }),
    ),
  }),
  success: Schema.Struct({ windows: Schema.Array(ComputerWindow) }),
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List desktop windows")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerWindowStateTool = Tool.make("computer_window_state", {
  description:
    "Read one window's grounded accessibility tree: actionable elements with roles, names, values, and bounds, plus a token for each element. Tokens are snapshot-scoped; re-observe after any action. Requires an active computer mission.",
  parameters: Schema.Struct({
    pid: Schema.Int,
    windowId: Schema.Int,
    includeScreenshot: Schema.optional(
      Schema.Boolean.annotate({
        description: "Attach a PNG of the window. Off by default to save tokens.",
      }),
    ),
  }),
  success: Schema.Struct({
    windowTitle: Schema.String,
    appName: Schema.String,
    elements: Schema.Array(ComputerElement),
    screenshotBase64: Schema.optional(Schema.String),
  }),
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read window elements")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const Target = Schema.Struct({
  pid: Schema.Int,
  windowId: Schema.Int,
  elementToken: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Element token from computer_window_state. Preferred over coordinates.",
    }),
  ),
  x: Schema.optional(Coordinate),
  y: Schema.optional(Coordinate),
});

export const ComputerClickTool = Tool.make("computer_click", {
  description:
    "Click one grounded element (elementToken) or a window-local coordinate. Requires an active computer mission.",
  parameters: Schema.Struct({
    ...Target.fields,
    button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
    count: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(3)),
    ),
  }),
  success: ComputerActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Click desktop element")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerTypeTool = Tool.make("computer_type", {
  description:
    "Type text into the focused surface, or into one grounded element when elementToken is given. Requires an active computer mission. Never type secrets the user did not dictate.",
  parameters: Schema.Struct({
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    elementToken: Schema.optional(TrimmedNonEmptyString),
    pid: Schema.optional(Schema.Int),
    windowId: Schema.optional(Schema.Int),
  }),
  success: ComputerActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Type text")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerKeyTool = Tool.make("computer_key", {
  description:
    "Press one key, optionally with modifiers, in the mission's target window. Requires an active computer mission.",
  parameters: Schema.Struct({
    key: TrimmedNonEmptyString.annotate({
      description: "Key name such as Return, Tab, Escape, or a single character.",
    }),
    modifiers: Schema.optional(Schema.Array(Schema.Literals(["ctrl", "alt", "shift", "meta"]))),
    pid: Schema.optional(Schema.Int),
    windowId: Schema.optional(Schema.Int),
  }),
  success: ComputerActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Press key")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerScrollTool = Tool.make("computer_scroll", {
  description: "Scroll the mission's target window. Requires an active computer mission.",
  parameters: Schema.Struct({
    direction: Schema.Literals(["up", "down", "left", "right"]),
    amount: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(50)),
    ),
    pid: Schema.optional(Schema.Int),
    windowId: Schema.optional(Schema.Int),
  }),
  success: ComputerActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Scroll window")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerLaunchAppTool = Tool.make("computer_launch_app", {
  description:
    "Launch an application on this node's desktop by name, bundle id, or launch path. Requires an active computer mission.",
  parameters: Schema.Struct({
    name: Schema.optional(TrimmedNonEmptyString),
    bundleId: Schema.optional(TrimmedNonEmptyString),
    launchPath: Schema.optional(TrimmedNonEmptyString),
    urls: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  success: ComputerActionResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Launch application")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerListAppsTool,
  ComputerListWindowsTool,
  ComputerWindowStateTool,
  ComputerClickTool,
  ComputerTypeTool,
  ComputerKeyTool,
  ComputerScrollTool,
  ComputerLaunchAppTool,
);
