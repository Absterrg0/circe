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
 * Linux desktop grounding through AT-SPI. Screen coordinates alone force a
 * model to invent a target; the accessibility tree gives it a bounded catalog
 * of real elements with roles, names, bounds, and actions, exactly the shape
 * the TypeSafe step layer selects over. This is the desktop analog of the
 * browser snapshot, and it is why a non-multimodal decision model can drive a
 * Linux desktop without looking at pixels.
 *
 * The tree is read by a short Python helper because AT-SPI is a D-Bus
 * protocol with no Node binding in this repo. The helper is embedded and run
 * through the ordinary desktop command runner, so it needs no packaging.
 */

export const ATSPI_MAX_ELEMENTS = 200;
export const ATSPI_MAX_DEPTH = 10;

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

/** Parse one helper dump. Throws on malformed output so the caller can escalate. */
export function parseAccessibilityDump(stdout: string): AccessibilityTree {
  return decodeAccessibilityTree(JSON.parse(stdout));
}

/**
 * Embedded AT-SPI reader. It walks the tree breadth-first, keeps only visible
 * nodes with real bounds that expose an action, edit, or focus, and prints one
 * bounded JSON object. Nothing here mutates the desktop.
 */
export const ATSPI_DUMP_SCRIPT = `
import json, sys
import pyatspi

MAX_ELEMENTS = ${ATSPI_MAX_ELEMENTS}
MAX_DEPTH = ${ATSPI_MAX_DEPTH}
INTERACTIVE_ROLES = {
    "push button", "toggle button", "menu item", "check box", "radio button",
    "combo box", "entry", "text", "link", "list item", "tab", "slider",
    "spin button", "page tab", "frame", "dialog", "window", "menu",
}

def extents(node):
    try:
        e = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    except Exception:
        return None
    if e.width <= 0 or e.height <= 0:
        return None
    return {"x": e.x, "y": e.y, "width": e.width, "height": e.height}

def actions(node):
    try:
        a = node.queryAction()
        return [a.getName(i) or "" for i in range(a.nActions)]
    except Exception:
        return []

def editable(node):
    try:
        node.queryEditableText()
        return True
    except Exception:
        return False

def main():
    out = []
    stack = []
    desktop = pyatspi.Registry.getDesktop(0)
    for i in range(desktop.childCount):
        app = desktop.getChildAtIndex(i)
        if app is not None:
            stack.append((app, "app:%d" % i, 0))
    while stack and len(out) < MAX_ELEMENTS:
        node, path, depth = stack.pop(0)
        if depth > MAX_DEPTH:
            continue
        try:
            role = node.getRoleName()
        except Exception:
            role = None
        try:
            name = node.name or ""
        except Exception:
            name = ""
        b = extents(node)
        acts = actions(node)
        edit = editable(node)
        # Bounds are the visibility proxy: the AT-SPI state set is not
        # reliable across compositors, and a zero-area node has nothing to
        # target anyway.
        if b is not None and (acts or edit or (role in INTERACTIVE_ROLES)):
            out.append({
                "id": path,
                "role": role,
                "name": name,
                "bounds": b,
                "editable": edit,
                "actions": acts,
            })
        try:
            count = node.childCount
        except Exception:
            count = 0
        for i in range(count):
            child = node.getChildAtIndex(i)
            if child is not None:
                stack.append((child, "%s/%d" % (path, i), depth + 1))
    json.dump({"elements": out}, sys.stdout)

main()
`.trim();

export function buildAccessibilityDumpCommand(): DesktopCommand {
  return { command: "python3", args: ["-c", ATSPI_DUMP_SCRIPT] };
}

/** Grounded elements from a decoded tree, bounded and addressable by id. */
export function accessibilityElements(
  tree: AccessibilityTree,
  limit = ATSPI_MAX_ELEMENTS,
): ReadonlyArray<ComputerElement> {
  const seen = new Set<string>();
  const elements: Array<ComputerElement> = [];
  for (const element of tree.elements) {
    if (seen.has(element.id)) continue;
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

export type AccessibilityCommandError = DesktopUseBackendError | DesktopUseTimeoutError;

/** Runs the AT-SPI helper; the server backs this with the desktop command runner. */
export type AccessibilityCommandRunner = (
  command: DesktopCommand,
  operation: string,
) => Effect.Effect<{ readonly stdout: string }, AccessibilityCommandError>;

export interface ObserveLinuxDesktopOptions {
  readonly title?: string;
  readonly limit?: number;
  readonly backend?: DesktopUseBackend;
}

/**
 * One grounded desktop surface from the live accessibility tree. Malformed or
 * unavailable output fails so the caller can escalate to another observer
 * rather than act on an invented catalog.
 */
export const observeLinuxDesktop = (
  runner: AccessibilityCommandRunner,
  options: ObserveLinuxDesktopOptions = {},
): Effect.Effect<ComputerSurface, AccessibilityCommandError> =>
  runner(buildAccessibilityDumpCommand(), "desktop.accessibility").pipe(
    Effect.flatMap(({ stdout }) =>
      Effect.try({
        try: () => desktopSurfaceFromAccessibility(parseAccessibilityDump(stdout), options),
        catch: (cause) =>
          new DesktopUseBackendError({
            backend: options.backend ?? "linux-wayland",
            operation: "desktop.accessibility",
            cause,
          }),
      }),
    ),
  );

/** Desktop surface for one accessibility dump, titled by the focused window if present. */
export function desktopSurfaceFromAccessibility(
  tree: AccessibilityTree,
  options: { readonly title?: string; readonly limit?: number } = {},
): ComputerSurface {
  const bounded = options.limit === undefined ? ATSPI_MAX_ELEMENTS : options.limit;
  return {
    kind: "desktop",
    title: options.title ?? "Desktop",
    elements: accessibilityElements(tree, bounded),
  };
}
