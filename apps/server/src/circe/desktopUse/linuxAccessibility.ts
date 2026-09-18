import type { DesktopUseBackend } from "@circe/contracts";
import * as Effect from "effect/Effect";

import type { ComputerSurface } from "@circe/core/computerUse";

import type { DesktopCommand } from "./platforms.ts";
import {
  observeAccessibility,
  type AccessibilityCommandError,
  type AccessibilityCommandRunner,
} from "./accessibilityTree.ts";

export {
  AccessibilityElement,
  AccessibilityTree,
  AccessibilityActionResult,
  accessibilityElements,
  decodeAccessibilityTree,
  decodeAccessibilityActionResult,
  decodeAccessibilityActionResultJson,
  desktopSurfaceFromAccessibility,
  parseAccessibilityDump,
  type AccessibilityCommandError,
  type AccessibilityCommandRunner,
} from "./accessibilityTree.ts";

/**
 * Linux desktop grounding through AT-SPI. AT-SPI is a D-Bus protocol with no
 * Node binding in this repo, so a short embedded Python helper reads the tree
 * and prints bounded JSON. The helper is embedded and run through the ordinary
 * desktop command runner, so it needs no packaging.
 */

export const ATSPI_MAX_ELEMENTS = 200;
export const ATSPI_MAX_DEPTH = 10;

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

/**
 * Embedded AT-SPI actuator. It resolves the element id produced by the dump
 * (an "app:N/idx/idx" path) and performs one action: activate for a click,
 * set-text for an editable field. It refuses a node whose role or name no
 * longer matches what the host captured. Output is a bounded JSON result.
 */
export const ATSPI_ACTION_SCRIPT = `
import json, sys
import pyatspi

def resolve(desktop, path):
    head, *rest = path.split("/")
    if not head.startswith("app:"):
        return None
    node = desktop.getChildAtIndex(int(head[4:]))
    for segment in rest:
        if node is None:
            return None
        node = node.getChildAtIndex(int(segment))
    return node

def unchanged(node, expect):
    if not expect:
        return True
    try:
        role = node.getRoleName()
    except Exception:
        role = None
    try:
        name = node.name or ""
    except Exception:
        name = ""
    return role == expect.get("role") and name == expect.get("name")

def activate(node):
    try:
        action = node.queryAction()
    except Exception as exc:
        return False, "no-action-interface: %s" % type(exc).__name__
    for i in range(action.nActions):
        name = (action.getName(i) or "").lower()
        if name in ("click", "activate", "press", "default.activate", "action"):
            try:
                return bool(action.doAction(i)), None
            except Exception as exc:
                return False, "action-failed: %s" % type(exc).__name__
    if action.nActions > 0:
        try:
            return bool(action.doAction(0)), None
        except Exception as exc:
            return False, "action-failed: %s" % type(exc).__name__
    return False, "no-action"

def set_text(node, text):
    try:
        node.queryEditableText().setTextContents(text)
        return True, None
    except Exception as exc:
        return False, "not-editable: %s" % type(exc).__name__

def main():
    payload = json.loads(sys.argv[1])
    desktop = pyatspi.Registry.getDesktop(0)
    node = resolve(desktop, payload.get("path", ""))
    if node is None:
        json.dump({"ok": False, "error": "element-not-found"}, sys.stdout)
        return
    if not unchanged(node, payload.get("expect")):
        json.dump({"ok": False, "error": "element-changed"}, sys.stdout)
        return
    action = payload.get("action")
    if action == "activate":
        ok, error = activate(node)
    elif action == "set-text":
        ok, error = set_text(node, payload.get("text", ""))
    else:
        ok, error = False, "unknown-action"
    json.dump({"ok": ok, "error": error}, sys.stdout)

main()
`.trim();

export interface AccessibilityActionExpectation {
  readonly role: string | null;
  readonly name: string;
}

export interface AccessibilityActionRequest {
  readonly path: string;
  readonly action: "activate" | "set-text";
  readonly text?: string;
  /** Identity captured with the path; the host refuses a mismatched node. */
  readonly expect?: AccessibilityActionExpectation;
}

export function buildAccessibilityActionCommand(
  request: AccessibilityActionRequest,
): DesktopCommand {
  return {
    command: "python3",
    args: ["-c", ATSPI_ACTION_SCRIPT, JSON.stringify(request)],
  };
}

export interface ObserveLinuxDesktopOptions {
  readonly title?: string;
  readonly limit?: number;
  readonly backend?: DesktopUseBackend;
}

export const observeLinuxDesktop = (
  runner: AccessibilityCommandRunner,
  options: ObserveLinuxDesktopOptions = {},
): Effect.Effect<ComputerSurface, AccessibilityCommandError> =>
  observeAccessibility(runner, buildAccessibilityDumpCommand(), "linux-wayland", options);
