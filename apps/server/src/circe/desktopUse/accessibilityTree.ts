import {
  DesktopUseBackendError,
  DesktopUseTimeoutError,
  type DesktopUseBackend,
} from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputerElement, ComputerSurface } from "@circe/core/computerUse";

import type { DesktopCommand } from "./platforms.ts";

/**
 * The shared desktop grounding contract. Every platform observer (AT-SPI on
 * Linux, System Events on macOS, UIAutomation on Windows) dumps the same
 * bounded JSON shape: a flat list of actionable elements with a stable id,
 * role, name, and bounds. The TypeSafe step layer selects over this catalog
 * and never sees pixels, so a non-multimodal decision model can drive any
 * desktop whose accessibility tree is readable.
 */

export const DEFAULT_ACCESSIBILITY_MAX_ELEMENTS = 200;

const BOUNDS = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

export const AccessibilityElement = Schema.Struct({
  id: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  bounds: BOUNDS,
  editable: Schema.Boolean,
  actions: Schema.Array(Schema.String),
});
export type AccessibilityElement = typeof AccessibilityElement.Type;

export const AccessibilityTree = Schema.Struct({
  elements: Schema.Array(AccessibilityElement),
});
export type AccessibilityTree = typeof AccessibilityTree.Type;

export const decodeAccessibilityTree = Schema.decodeUnknownSync(AccessibilityTree);
const decodeAccessibilityTreeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(AccessibilityTree),
);

/** Parse one platform dump. Throws on malformed output so the caller can escalate. */
export function parseAccessibilityDump(stdout: string): AccessibilityTree {
  return decodeAccessibilityTreeJson(stdout.trim());
}

export const AccessibilityActionResult = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
export type AccessibilityActionResult = typeof AccessibilityActionResult.Type;

export const decodeAccessibilityActionResult = Schema.decodeUnknownSync(AccessibilityActionResult);
export const decodeAccessibilityActionResultJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(AccessibilityActionResult),
);

export type AccessibilityCommandError = DesktopUseBackendError | DesktopUseTimeoutError;

/** Runs a platform observer or actuator; the server backs it with DesktopCommands. */
export type AccessibilityCommandRunner = (
  command: DesktopCommand,
  operation: string,
) => Effect.Effect<{ readonly stdout: string }, AccessibilityCommandError>;

/** Grounded elements from a decoded tree, bounded and addressable by id. */
export function accessibilityElements(
  tree: AccessibilityTree,
  limit = DEFAULT_ACCESSIBILITY_MAX_ELEMENTS,
): ReadonlyArray<ComputerElement> {
  const seen = new Set<string>();
  const elements: Array<ComputerElement> = [];
  for (const element of tree.elements) {
    if (element.id.length === 0 || seen.has(element.id)) continue;
    seen.add(element.id);
    elements.push({
      id: element.id,
      role: element.role,
      name: element.name,
      bounds: {
        x: element.bounds.x,
        y: element.bounds.y,
        width: element.bounds.width,
        height: element.bounds.height,
      },
    });
    if (elements.length >= limit) break;
  }
  return elements;
}

/** Desktop surface for one accessibility dump, titled by the focused window if present. */
export function desktopSurfaceFromAccessibility(
  tree: AccessibilityTree,
  options: { readonly title?: string; readonly limit?: number } = {},
): ComputerSurface {
  const bounded = options.limit ?? DEFAULT_ACCESSIBILITY_MAX_ELEMENTS;
  return {
    kind: "desktop",
    title: options.title ?? "Desktop",
    elements: accessibilityElements(tree, bounded),
  };
}

export interface AccessibilityObserverOptions {
  readonly title?: string;
  readonly limit?: number;
  readonly backend?: DesktopUseBackend;
}

/**
 * One grounded surface from a platform dump command. Malformed or unavailable
 * output fails so the caller can escalate to another observer instead of
 * acting on an invented catalog.
 */
export const observeAccessibility = (
  runner: AccessibilityCommandRunner,
  command: DesktopCommand,
  fallbackBackend: DesktopUseBackend,
  options: AccessibilityObserverOptions = {},
): Effect.Effect<ComputerSurface, AccessibilityCommandError> =>
  runner(command, "desktop.accessibility").pipe(
    Effect.flatMap(({ stdout }) =>
      Effect.try({
        try: () => desktopSurfaceFromAccessibility(parseAccessibilityDump(stdout), options),
        catch: (cause) =>
          new DesktopUseBackendError({
            backend: options.backend ?? fallbackBackend,
            operation: "desktop.accessibility",
            cause,
          }),
      }),
    ),
  );
