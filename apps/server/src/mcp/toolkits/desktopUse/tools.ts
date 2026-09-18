import {
  DesktopUseError,
  DesktopUseFrame,
  DesktopUseInputResult,
  DesktopUseModifier,
  DesktopUseMouseButton,
  DesktopUseStatus,
  DesktopUseWindowList,
  McpCapabilityUnavailableError,
  TrimmedNonEmptyString,
} from "@circe/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as DesktopUse from "../../../circe/desktopUse/DesktopUse.ts";
import {
  DesktopSurface,
  DesktopSurfaceBackendError,
  DesktopSurfaceStaleError,
  DesktopSurfaceUnavailableError,
} from "../../../circe/desktopSurface/Services/DesktopSurface.ts";
import { CirceDecision } from "../../../circe/Services/CirceDecision.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, DesktopUse.DesktopUse];
const observeDependencies = [...dependencies, DesktopSurface];
const decideDependencies = [...observeDependencies, CirceDecision];

export const DesktopUseToolError = Schema.Union([McpCapabilityUnavailableError, DesktopUseError]);
export type DesktopUseToolError = typeof DesktopUseToolError.Type;

const DisplayTarget = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "Display id from the last desktop_status or desktop_screenshot. Omit for the primary display.",
  }),
);

const Coordinate = Schema.Finite.annotate({
  description:
    "Pointer coordinate in the returned screenshot's pixels, measured from its top-left. Frames are normalized to the native pointer grid.",
});

const Button = Schema.optional(
  DesktopUseMouseButton.annotate({
    description: "Mouse button. Defaults to left.",
  }),
);

const Modifiers = Schema.optional(
  Schema.Array(DesktopUseModifier).annotate({
    description: "Modifier keys held while pressing the key.",
  }),
);

export const DesktopStatusTool = Tool.make("desktop_status", {
  description:
    "Report whether this node can drive its own desktop: platform, backend, displays, and which action classes are supported. Call this before the first pointer or keyboard action.",
  success: DesktopUseStatus,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read desktop status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DesktopScreenshotTool = Tool.make("desktop_screenshot", {
  description:
    "Capture the current desktop screen as a PNG. Returns the image plus display metadata, and reports the pointer position when the platform exposes it. Use this to see what is on screen before acting.",
  parameters: Schema.Struct({ displayId: DisplayTarget }),
  success: DesktopUseFrame,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot desktop")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DesktopMoveTool = Tool.make("desktop_move", {
  description: "Move the pointer to an absolute coordinate on a display.",
  parameters: Schema.Struct({ x: Coordinate, y: Coordinate, displayId: DisplayTarget }),
  success: DesktopUseInputResult,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Move pointer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DesktopClickTool = Tool.make("desktop_click", {
  description:
    "Click a mouse button. Pass x and y to move first, or omit them to click wherever the pointer already is. count 2 is a double click.",
  parameters: Schema.Struct({
    x: Schema.optional(Coordinate),
    y: Schema.optional(Coordinate),
    button: Button,
    count: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(3))
        .annotate({
          description: "Number of clicks. Defaults to 1.",
        }),
    ),
    displayId: DisplayTarget,
  }).check(
    Schema.makeFilter(
      (input) =>
        (input.x === undefined) === (input.y === undefined) || "Provide both x and y, or neither.",
    ),
  ),
  success: DesktopUseInputResult,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Click")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const DesktopDragTool = Tool.make("desktop_drag", {
  description: "Press the pointer at one coordinate, drag to another, and release.",
  parameters: Schema.Struct({
    fromX: Coordinate,
    fromY: Coordinate,
    toX: Coordinate,
    toY: Coordinate,
    button: Button,
    durationMs: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(60_000))
        .annotate({
          description: "Drag duration in milliseconds. Defaults to 250.",
        }),
    ),
    displayId: DisplayTarget,
  }),
  success: DesktopUseInputResult,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Drag")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const DesktopScrollTool = Tool.make("desktop_scroll", {
  description:
    "Scroll at a coordinate. Positive deltaY scrolls down, positive deltaX scrolls right.",
  parameters: Schema.Struct({
    x: Schema.optional(Coordinate),
    y: Schema.optional(Coordinate),
    deltaX: Schema.optional(Schema.Finite.annotate({ description: "Horizontal scroll amount." })),
    deltaY: Schema.optional(Schema.Finite.annotate({ description: "Vertical scroll amount." })),
    displayId: DisplayTarget,
  }).check(
    Schema.makeFilter(
      (input) =>
        (input.x === undefined) === (input.y === undefined) || "Provide both x and y, or neither.",
    ),
  ),
  success: DesktopUseInputResult,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Scroll")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const DesktopTypeTool = Tool.make("desktop_type", {
  description: "Type literal text into whatever currently has keyboard focus.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMaxLength(4_096)).annotate({
      description: "Text to type, up to 4096 characters.",
    }),
    displayId: DisplayTarget,
  }),
  success: DesktopUseInputResult,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Type text")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const DesktopKeyTool = Tool.make("desktop_key", {
  description:
    "Press one keyboard key, optionally with modifiers. Special keys use names like enter, escape, tab, backspace, up, down, pageup, f5.",
  parameters: Schema.Struct({
    key: TrimmedNonEmptyString.annotate({
      description: "Key name or a single character, for example enter, tab, escape, a, 7.",
    }),
    modifiers: Modifiers,
    displayId: DisplayTarget,
  }),
  success: DesktopUseInputResult,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Press key")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const DesktopWindowsTool = Tool.make("desktop_windows", {
  description: "List visible windows on this node with their titles and bounds.",
  success: DesktopUseWindowList,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "List desktop windows")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DesktopFocusWindowTool = Tool.make("desktop_focus_window", {
  description: "Bring a window listed by desktop_windows to the foreground.",
  parameters: Schema.Struct({
    windowId: TrimmedNonEmptyString.annotate({
      description: "Window id from desktop_windows.",
    }),
  }),
  success: DesktopUseInputResult,
  failure: DesktopUseToolError,
  dependencies,
})
  .annotate(Tool.Title, "Focus window")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SurfaceBounds = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

export const DesktopSurfaceRegion = Schema.Struct({
  id: TrimmedNonEmptyString,
  role: Schema.NullOr(TrimmedNonEmptyString),
  name: Schema.String,
  bounds: SurfaceBounds,
  source: Schema.Literals(["semantic", "visual"]),
  interactive: Schema.Boolean,
});
export type DesktopSurfaceRegion = typeof DesktopSurfaceRegion.Type;

export const DesktopSurfaceSnapshotResult = Schema.Struct({
  captureId: TrimmedNonEmptyString,
  displayId: TrimmedNonEmptyString,
  title: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  regions: Schema.Array(DesktopSurfaceRegion),
});
export type DesktopSurfaceSnapshotResult = typeof DesktopSurfaceSnapshotResult.Type;

export const DesktopSurfaceActionSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    captureId: TrimmedNonEmptyString,
    regionId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    captureId: TrimmedNonEmptyString,
    regionId: Schema.optional(TrimmedNonEmptyString),
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("press"),
    captureId: TrimmedNonEmptyString,
    regionId: Schema.optional(TrimmedNonEmptyString),
    key: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    captureId: TrimmedNonEmptyString,
    regionId: Schema.optional(TrimmedNonEmptyString),
    direction: Schema.Literals(["up", "down", "left", "right"]),
  }),
]);
export type DesktopSurfaceActionSchema = typeof DesktopSurfaceActionSchema.Type;

export const DesktopDecideResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("action"), action: DesktopSurfaceActionSchema }),
  Schema.Struct({ status: Schema.Literal("done"), summary: Schema.String }),
  Schema.Struct({ status: Schema.Literal("wait") }),
  Schema.Struct({ status: Schema.Literal("refused"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("unavailable"), message: Schema.String }),
]);
export type DesktopDecideResult = typeof DesktopDecideResult.Type;

export const DesktopActResult = Schema.Struct({ applied: Schema.Boolean });
export type DesktopActResult = typeof DesktopActResult.Type;

const DesktopSurfaceToolError = Schema.Union([
  McpCapabilityUnavailableError,
  DesktopSurfaceUnavailableError,
  DesktopSurfaceStaleError,
  DesktopSurfaceBackendError,
]);

export const DesktopObserveTool = Tool.make("desktop_observe", {
  description:
    "Read this node's desktop as a bounded, addressable snapshot: a captureId plus the interactive elements (id, role, name, bounds) the accessibility tree offers. Act only on an id this snapshot listed, and pass its captureId back so a changed screen is refused instead of mis-clicked. Prefer this over raw coordinates whenever the app exposes an accessibility tree.",
  parameters: Schema.Struct({
    displayId: DisplayTarget,
    includeVisual: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Also merge visual regions from the node's perception provider, when one is configured. Accessibility ids are always included.",
      }),
    ),
  }),
  success: DesktopSurfaceSnapshotResult,
  failure: DesktopSurfaceToolError,
  dependencies: observeDependencies,
})
  .annotate(Tool.Title, "Observe the desktop")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DesktopDecideTool = Tool.make("desktop_decide", {
  description:
    "Ask TypeSafe to choose the single next step for a goal over the elements desktop_observe just offered. Returns one capture-bound action, or done, wait, or a refusal. It never invents a target; the surface revalidates the choice before acting.",
  parameters: Schema.Struct({
    captureId: TrimmedNonEmptyString.annotate({
      description: "The captureId from the desktop_observe call this decision is about.",
    }),
    goal: TrimmedNonEmptyString.annotate({
      description: "What to accomplish, in plain language.",
    }),
  }),
  success: DesktopDecideResult,
  failure: DesktopSurfaceToolError,
  dependencies: decideDependencies,
})
  .annotate(Tool.Title, "Decide the next desktop step")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DesktopActTool = Tool.make("desktop_act", {
  description:
    "Perform exactly one capture-bound desktop action chosen from the current snapshot. A click, type, or key names an element id from that snapshot; type, key, and scroll may instead act on the focused element. The action is refused as stale when the desktop changed since it was observed.",
  parameters: Schema.Struct({ action: DesktopSurfaceActionSchema }),
  success: DesktopActResult,
  failure: DesktopSurfaceToolError,
  dependencies: observeDependencies,
})
  .annotate(Tool.Title, "Act on the desktop")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const DesktopUseToolkit = Toolkit.make(
  DesktopStatusTool,
  DesktopMoveTool,
  DesktopClickTool,
  DesktopDragTool,
  DesktopScrollTool,
  DesktopTypeTool,
  DesktopKeyTool,
  DesktopWindowsTool,
  DesktopFocusWindowTool,
  DesktopObserveTool,
  DesktopDecideTool,
  DesktopActTool,
);
