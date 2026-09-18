import type { DesktopUseFrame } from "@circe/contracts";
import type { DesktopRegion } from "@circe/core/desktopSurface";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Optional visual grounding: a screenshot in, addressable regions out. It is
 * the only place a third-party grounder would live, so the core stays free of
 * model weights and their licenses. The default has none, and semantic
 * accessibility remains the surface.
 */
export interface DesktopPerceptionShape {
  readonly regions: (input: {
    readonly frame: DesktopUseFrame;
    readonly title: string;
  }) => Effect.Effect<ReadonlyArray<DesktopRegion>>;
}

export class DesktopPerception extends Context.Service<DesktopPerception, DesktopPerceptionShape>()(
  "@absterrg0/circe/circe/desktopSurface/Services/DesktopPerception",
) {}

/** No grounder configured: visual observation yields no regions. */
export const DesktopPerceptionNone: Layer.Layer<DesktopPerception> = Layer.succeed(
  DesktopPerception,
  { regions: () => Effect.succeed([]) },
);
