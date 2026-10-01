import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@circe/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { ComputerService } from "../../../computer/ComputerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Provider-facing computer tools. The desktop host owns the OS session; this
 * surface is only a window into ComputerService, which enforces the active
 * mission. A model never grants itself a mission: `computer_begin` asks the
 * user through Circe, and only the user's approval hands a mission to this
 * exact provider session. Every call is audited by the service.
 */

const dependencies = [McpInvocationContext.McpInvocationContext, ComputerService];

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
      nativeGrounding: Schema.Boolean,
      visualGrounding: Schema.Boolean,
    }),
  ),
});
export type ComputerStatusResult = typeof ComputerStatusResult.Type;

export const ComputerApp = Schema.Struct({
  name: TrimmedNonEmptyString,
  pid: Schema.optional(Schema.Int),
  running: Schema.Boolean,
  active: Schema.optional(Schema.Boolean),
  launchPath: Schema.optional(Schema.String),
  bundleId: Schema.optional(Schema.String),
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

/**
 * One control the host can act on. `controlId` is valid only for the
 * observation that returned it; the host keeps the executable address.
 */
export const ComputerControl = Schema.Struct({
  controlId: TrimmedNonEmptyString,
  /** `native`: an accessibility element. `visual`: read from pixels, click only. */
  source: Schema.Literals(["native", "visual"]),
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  value: Schema.optional(Schema.String),
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type ComputerControl = typeof ComputerControl.Type;

export const ComputerWindowState = Schema.Struct({
  windowTitle: Schema.String,
  appName: Schema.String,
  controls: Schema.Array(ComputerControl),
  text: Schema.optional(Schema.Array(Schema.String)),
  limitation: Schema.optional(Schema.String),
  screenshotBase64: Schema.optional(Schema.String),
});

export const ComputerActionResult = Schema.Struct({
  ok: Schema.Boolean,
  effect: TrimmedNonEmptyString,
  text: Schema.String,
  refusalCode: Schema.optional(TrimmedNonEmptyString),
  windowState: Schema.optional(ComputerWindowState),
  observationError: Schema.optional(Schema.String),
});
export type ComputerActionResult = typeof ComputerActionResult.Type;

export class ComputerToolError extends Schema.TaggedError<ComputerToolError>()(
  "ComputerToolError",
  {
    code: TrimmedNonEmptyString,
    message: Schema.String,
  },
) {}

export const ComputerToolFailure = Schema.Union([ComputerToolError, McpCapabilityUnavailableError]);

export const ComputerStatusTool = Tool.make("computer_status", {
  description:
    "Report whether this node can drive its own desktop and whether a computer mission is active for this session. Every action tool refuses until computer_begin is granted.",
  success: ComputerStatusResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read computer status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerBeginResult = Schema.Struct({
  status: Schema.Literals(["granted", "waiting", "declined"]),
  message: Schema.String,
});
export type ComputerBeginResult = typeof ComputerBeginResult.Type;

export const ComputerBeginTool = Tool.make("computer_begin", {
  description:
    "Ask the user for this computer. Circe asks them to approve the goal; once they do, this session holds a computer mission and the other computer tools work until computer_end or the end of this run. Returns granted, declined, or waiting; on waiting, call it again with the same goal to keep waiting.",
  parameters: Schema.Struct({
    goal: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)).annotate({
      description: "What you will do on the computer, in words the user can approve.",
    }),
  }),
  success: ComputerBeginResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Ask to use the computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerEndTool = Tool.make("computer_end", {
  description: "Hand the computer back when you are done with it.",
  success: Schema.Struct({ released: Schema.Boolean }),
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Hand the computer back")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerListAppsTool = Tool.make("computer_list_apps", {
  description:
    "Find installed and open desktop applications. Closed apps include launchPath for computer_launch_app. Background processes are omitted on Linux. Requires an active computer mission.",
  parameters: Schema.Struct({ query: Schema.optional(TrimmedNonEmptyString) }),
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
    "Observe one window and list the controls you can act on, each with a controlId. Accessibility controls come first; when a window draws its own controls, text and controls read from the screen are listed too (source visual, click only). Use controlIds from the newest observation, including windowState returned by click or type. Requires an active computer mission.",
  parameters: Schema.Struct({
    pid: Schema.Int,
    windowId: Schema.Int,
    lookCloser: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Also read controls from the screen when the accessible controls do not include what you need.",
      }),
    ),
    includeScreenshot: Schema.optional(
      Schema.Boolean.annotate({
        description: "Attach a PNG of the window. Off by default to save tokens.",
      }),
    ),
  }),
  success: ComputerWindowState,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read window elements")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerClickTool = Tool.make("computer_click", {
  description:
    "Click one control from the latest computer_window_state by its controlId. Returns a fresh windowState after the click; use its controls for the next action without another observation call. There is no coordinate click. Requires an active computer mission.",
  parameters: Schema.Struct({
    controlId: TrimmedNonEmptyString,
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
    "Type complete text in one call rather than clicking individual characters. Returns a fresh windowState with new controlIds for the next action. Target an observed native text field: supply its controlId for background delivery. A drawn field may lack background typing. Report that limitation; use delivery foreground with exact pid and windowId only when the user explicitly requests foreground work. Requires an active computer mission. Never type secrets the user did not dictate.",
  parameters: Schema.Struct({
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
    controlId: Schema.optional(TrimmedNonEmptyString),
    pid: Schema.optional(Schema.Int),
    windowId: Schema.optional(Schema.Int),
    delivery: Schema.optional(Schema.Literals(["background", "foreground"])),
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
    "Prefer clicking an observed native button for submit, equals, or other button actions. Keyboard delivery may be unavailable even when native controls work. Press one key, optionally with modifiers, in the target window. Background is the default. When background input is unavailable, report the limitation. Use delivery foreground only when the user explicitly requests foreground work, with an observed exact pid and windowId. Requires an active computer mission.",
  parameters: Schema.Struct({
    key: TrimmedNonEmptyString.annotate({
      description: "Key name such as Return, Tab, Escape, or a single character.",
    }),
    modifiers: Schema.optional(Schema.Array(Schema.Literals(["ctrl", "alt", "shift", "meta"]))),
    pid: Schema.optional(Schema.Int),
    windowId: Schema.optional(Schema.Int),
    delivery: Schema.optional(Schema.Literals(["background", "foreground"])),
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
    "Launch an application by name, bundle id, or launchPath from computer_list_apps. Returned windows identify the launched app: read one with computer_window_state directly. If no window is returned, check computer_list_windows once; do not repeatedly launch or debug the desktop with shell commands. Requires an active computer mission.",
  parameters: Schema.Struct({
    name: Schema.optional(TrimmedNonEmptyString),
    bundleId: Schema.optional(TrimmedNonEmptyString),
    launchPath: Schema.optional(TrimmedNonEmptyString),
    urls: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  success: Schema.Struct({
    ...ComputerActionResult.fields,
    pid: Schema.optional(Schema.Int),
    windows: Schema.Array(ComputerWindow),
  }),
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Launch application")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const PlanTarget = Schema.Struct({
  role: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
const PlanExpectation = Schema.Struct({
  shows: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  in: Schema.optional(PlanTarget),
});

/** Steps the calling model already knows; Circe grounds each against a fresh observation. */
export const ComputerGoalPlan = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      verb: Schema.Literals(["launch", "click", "fill", "select", "press", "scroll", "inspect"]),
      intent: Schema.String.check(Schema.isMaxLength(200)),
      app: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
      newWindow: Schema.optional(Schema.Boolean),
      target: Schema.optional(PlanTarget),
      text: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
      replace: Schema.optional(Schema.Boolean),
      option: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      key: Schema.optional(Schema.String.check(Schema.isMaxLength(20))),
      direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])),
      requires: Schema.optional(PlanTarget),
      expect: Schema.optional(PlanExpectation),
    }),
  ).check(Schema.isMaxLength(8)),
  done: Schema.optional(PlanExpectation),
});

export const ComputerDoResult = Schema.Struct({
  status: Schema.Literals([
    "done",
    "unverified",
    "uncertain",
    "failed",
    "stopped",
    "needs-input",
    "unavailable",
    "waiting",
    "declined",
  ]),
  message: Schema.String,
  actions: Schema.optional(Schema.Int),
  /** Where the time went, for a caller that reports it. */
  timings: Schema.optional(
    Schema.Struct({
      totalMs: Schema.Finite,
      plannerCalls: Schema.Int,
      plannerMs: Schema.Finite,
      jevCalls: Schema.Int,
      jevMs: Schema.Finite,
      actionMs: Schema.Finite,
      verifyMs: Schema.Finite,
    }),
  ),
});
export type ComputerDoResult = typeof ComputerDoResult.Type;

export const ComputerDoTool = Tool.make("computer_do", {
  description:
    'Carry out a whole desktop goal on this computer in one call, such as "calculate 12 times 7 in Calculator" or "search for heart in Characters". Circe opens or reuses the application, finds each control in a fresh look at the window, chooses among matching controls, acts, and checks the result on screen. It asks the user for the computer first when this run does not hold it; on waiting, call again with the same goal. Always pass `plan`, written from how the app normally looks (for a search: click the Search button, then fill the search box); Circe grounds every step in the live window and replans only when it differs, while leaving `plan` out makes it ask a separate, slower planning model first. Enter whole text or expressions with one fill of a text box, using its role alone when unnamed; never assemble text or numbers by clicking individual character buttons, and never fill the same field twice, since each fill replaces it. A fill of a field that already holds text is refused unless the step sets `replace: true`: set it only when the goal asks to change what is already there (a new calculation over an old entry). Never set it for a new, blank or empty document. Submit by clicking the visible control that does it (=, Search, OK) rather than a press step: Circe works in the background, where keys often cannot reach the window. Use literal display values for expectations, never prose descriptions. Plan steps (verbs launch, click, fill, select, press, scroll, inspect; targets by role and name as the app shows them; `done.shows` for what the window shows once finished). Only status done means the screen showed the result; unverified means every step ran but the window exposes nothing more to confirm it, so report what was done instead of repeating it with other tools.',
  parameters: Schema.Struct({
    goal: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)).annotate({
      description:
        "The whole goal in the user's words, which Circe also shows the user for approval.",
    }),
    plan: Schema.optional(ComputerGoalPlan),
    text: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)).annotate({
        description: "Exact text to type when it is not in the goal's own words.",
      }),
    ),
  }),
  success: ComputerDoResult,
  failure: ComputerToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Carry out a desktop goal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ComputerToolkit = Toolkit.make(
  ComputerDoTool,
  ComputerStatusTool,
  ComputerBeginTool,
  ComputerEndTool,
  ComputerListAppsTool,
  ComputerListWindowsTool,
  ComputerWindowStateTool,
  ComputerClickTool,
  ComputerTypeTool,
  ComputerKeyTool,
  ComputerScrollTool,
  ComputerLaunchAppTool,
);
