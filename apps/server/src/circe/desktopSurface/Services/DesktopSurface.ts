import type { DesktopSnapshot, DesktopSurfaceAction } from "@circe/core/desktopSurface";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The node has no usable surface (headless, or a platform without an adapter). */
export class DesktopSurfaceUnavailableError extends Schema.TaggedError<DesktopSurfaceUnavailableError>()(
  "DesktopSurfaceUnavailableError",
  { reason: Schema.String },
) {}

/** The action named a capture the live surface has moved past. */
export class DesktopSurfaceStaleError extends Schema.TaggedError<DesktopSurfaceStaleError>()(
  "DesktopSurfaceStaleError",
  { captureId: Schema.String },
) {
  override get message(): string {
    return "The desktop changed since it was observed; observe again before acting.";
  }
}

/** A capture or input command failed at the platform layer. */
export class DesktopSurfaceBackendError extends Schema.TaggedError<DesktopSurfaceBackendError>()(
  "DesktopSurfaceBackendError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export type DesktopSurfaceError =
  | DesktopSurfaceUnavailableError
  | DesktopSurfaceStaleError
  | DesktopSurfaceBackendError;

export interface DesktopObserveInput {
  readonly title?: string;
}

/**
 * One node's desktop surface. `observe` produces a bounded, addressable
 * snapshot; `act` executes one capture-bound action and refuses when the
 * surface moved on. Semantic capture (an accessibility tree) and visual
 * capture (a screenshot parsed into regions) produce the same snapshot shape,
 * so no caller learns which one it saw.
 */
export interface DesktopSurfaceShape {
  readonly observe: (
    input?: DesktopObserveInput,
  ) => Effect.Effect<DesktopSnapshot, DesktopSurfaceError>;
  readonly act: (action: DesktopSurfaceAction) => Effect.Effect<void, DesktopSurfaceError>;
}

export class DesktopSurface extends Context.Service<DesktopSurface, DesktopSurfaceShape>()(
  "@absterrg0/circe/circe/desktopSurface/Services/DesktopSurface",
) {}
