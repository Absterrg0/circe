/**
 * The desktop surface contract, pure and testable. A capture yields one
 * bounded, addressable snapshot; an action is bound to the capture it was
 * chosen against. If the live surface moved on, the action is refused as stale
 * rather than landing on whatever now occupies those pixels. Perception (a
 * screenshot parsed into visual regions) and semantic capture (an
 * accessibility tree) produce the same snapshot shape, so the decision layer
 * never learns which one it saw.
 */

import type { ComputerAction, ComputerSurface } from "./computerUse.ts";

export type DesktopSurfaceSource = "semantic" | "visual" | "semantic+visual";

export interface DesktopRegionBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One addressable target. `id` is host-derived and stable within a capture. */
export interface DesktopRegion {
  readonly id: string;
  readonly role: string | null;
  readonly name: string;
  readonly bounds: DesktopRegionBounds;
  readonly source: "semantic" | "visual";
  /** Whether the region can be the target of a pointer or text action. */
  readonly interactive: boolean;
}

export interface DesktopCapture {
  readonly captureId: string;
  readonly displayId: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly takenAtMs: number;
  readonly source: DesktopSurfaceSource;
}

export interface DesktopSnapshot {
  readonly capture: DesktopCapture;
  readonly title: string;
  readonly regions: ReadonlyArray<DesktopRegion>;
  /** Bounded, already-safe text for the decision layer. */
  readonly visibleText?: string;
}

export const DESKTOP_SURFACE_SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type DesktopSurfaceScrollDirection = (typeof DESKTOP_SURFACE_SCROLL_DIRECTIONS)[number];

/**
 * A finite action. `captureId` is mandatory: the caller states which surface it
 * decided against, and the host refuses the action if that capture is no longer
 * the live one.
 */
export type DesktopSurfaceAction =
  | { readonly kind: "click"; readonly captureId: string; readonly regionId: string }
  | {
      readonly kind: "type";
      readonly captureId: string;
      readonly regionId?: string | undefined;
      readonly text: string;
    }
  | {
      readonly kind: "press";
      readonly captureId: string;
      readonly regionId?: string | undefined;
      readonly key: string;
    }
  | {
      readonly kind: "scroll";
      readonly captureId: string;
      readonly regionId?: string | undefined;
      readonly direction: DesktopSurfaceScrollDirection;
    };

export type DesktopSurfaceRefusal =
  | "stale-capture"
  | "unknown-region"
  | "non-interactive-region"
  | "missing-parameter";

export class DesktopSurfaceStaleError extends Error {
  readonly reason = "stale-capture" as const;
  constructor() {
    super("The desktop changed since it was observed; observe again before acting.");
  }
}

export function findDesktopRegion(
  snapshot: DesktopSnapshot,
  regionId: string,
): DesktopRegion | undefined {
  return snapshot.regions.find((region) => region.id === regionId);
}

export function desktopRegionLabel(region: DesktopRegion): string {
  const role = region.role === null || region.role.length === 0 ? "element" : region.role;
  return `${role}: ${region.name}`;
}

/**
 * The smallest proof a surface can give that an action is safe to attempt.
 * Returns a refusal reason or null when the action is well-formed against the
 * snapshot. It is pure: the caller still revalidates against the live surface
 * before acting.
 */
export function validateDesktopSurfaceAction(
  snapshot: DesktopSnapshot,
  action: DesktopSurfaceAction,
): DesktopSurfaceRefusal | null {
  if (action.captureId !== snapshot.capture.captureId) return "stale-capture";

  if (action.kind === "type" && action.text.trim().length === 0) return "missing-parameter";
  if (action.kind === "press" && action.key.trim().length === 0) return "missing-parameter";
  if (action.kind === "scroll") return null;

  if (action.regionId === undefined) {
    // Typing or pressing without a target acts on the focused element; only
    // click strictly requires a region.
    return action.kind === "click" ? "missing-parameter" : null;
  }

  const region = findDesktopRegion(snapshot, action.regionId);
  if (region === undefined) return "unknown-region";
  if (action.kind === "click" && !region.interactive) return "non-interactive-region";
  return null;
}

/** A snapshot with at least one interactive region can be acted on at all. */
export function desktopSnapshotIsActionable(snapshot: DesktopSnapshot): boolean {
  return snapshot.regions.some((region) => region.interactive);
}

/** The decision loop's view of a snapshot: the same elements, no capture ids. */
export function computerSurfaceFromSnapshot(snapshot: DesktopSnapshot): ComputerSurface {
  return {
    kind: "desktop",
    title: snapshot.title,
    elements: snapshot.regions.map((region) => ({
      id: region.id,
      role: region.role,
      name: region.name,
      bounds: region.bounds,
    })),
  };
}

/**
 * Bind a decision to the capture it was chosen against. Returns null for a
 * wait, which needs no surface action.
 */
export function surfaceActionFromComputerAction(
  captureId: string,
  action: ComputerAction,
): DesktopSurfaceAction | null {
  switch (action.kind) {
    case "click":
      return { kind: "click", captureId, regionId: action.elementId };
    case "type":
      return {
        kind: "type",
        captureId,
        ...(action.elementId === undefined ? {} : { regionId: action.elementId }),
        text: action.text,
      };
    case "press":
      return {
        kind: "press",
        captureId,
        ...(action.elementId === undefined ? {} : { regionId: action.elementId }),
        key: action.key,
      };
    case "scroll":
      return { kind: "scroll", captureId, direction: action.direction };
    case "wait":
      return null;
  }
}
