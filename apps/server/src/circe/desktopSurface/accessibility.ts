import type { DesktopUseBackend } from "@circe/contracts";
import type { ComputerSurface } from "@circe/core/computerUse";
import * as Effect from "effect/Effect";

import {
  buildAccessibilityActionCommand,
  decodeAccessibilityActionResultJson,
  observeLinuxDesktop,
  type AccessibilityActionRequest,
  type AccessibilityCommandError,
  type AccessibilityCommandRunner,
} from "../desktopUse/linuxAccessibility.ts";

/**
 * The platform semantic surface: read the accessibility tree, then act on one
 * element it listed, naming the identity it was observed with. This is the one
 * genuinely platform-specific piece of desktop use — AT-SPI on Linux, AX on
 * macOS, UIA on Windows — and it lets the surface, decision, and tool layers
 * stay platform-neutral.
 */
export interface DesktopAccessibilityAdapter {
  readonly observe: (input: {
    readonly runner: AccessibilityCommandRunner;
    readonly backend: DesktopUseBackend;
    readonly title?: string;
  }) => Effect.Effect<ComputerSurface, AccessibilityCommandError>;
  readonly action: (input: {
    readonly runner: AccessibilityCommandRunner;
    readonly request: AccessibilityActionRequest;
  }) => Effect.Effect<"ok" | "no-action" | "refuse", AccessibilityCommandError>;
}

const decodeAction = (stdout: string): "ok" | "no-action" | "refuse" => {
  try {
    const result = decodeAccessibilityActionResultJson(stdout);
    if (result.ok) return "ok";
    if (result.error === "element-changed" || result.error === "element-not-found") return "refuse";
    // A helper with no action interface still reports the element; the caller
    // may fall back to the pointer after revalidating the element's identity.
    return "no-action";
  } catch {
    return "no-action";
  }
};

/** Linux drives AT-SPI through an embedded helper run by the command runner. */
export const linuxAccessibilityAdapter: DesktopAccessibilityAdapter = {
  observe: ({ runner, backend, title }) =>
    observeLinuxDesktop(runner, { backend, ...(title === undefined ? {} : { title }) }),
  action: ({ runner, request }) =>
    runner(buildAccessibilityActionCommand(request), "desktop.surface.act").pipe(
      Effect.map(({ stdout }) => decodeAction(stdout)),
    ),
};

const SUPPORTED_BACKENDS: ReadonlySet<DesktopUseBackend> = new Set(["linux-x11", "linux-wayland"]);

/**
 * Resolve the semantic adapter for a backend. macOS and Windows adapters
 * implement this same interface; until they land those platforms report the
 * surface unavailable rather than pretending to have one.
 */
export const accessibilityAdapterFor = (
  backend: DesktopUseBackend,
): DesktopAccessibilityAdapter | null =>
  SUPPORTED_BACKENDS.has(backend) ? linuxAccessibilityAdapter : null;
