import type { DesktopUseFrame } from "@circe/contracts";
import type { ComputerSurface } from "@circe/core/computerUse";
import {
  buildVisionGroundingPrompt,
  parseVisionGrounding,
  VISION_GROUNDING_MAX_ELEMENTS,
} from "@circe/core/visionGrounding";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Vision grounding: a multimodal model turns a screenshot into the same
 * bounded element catalog the accessibility observers produce. It is the
 * escalation for surfaces with no usable accessibility tree (canvas, GL,
 * games). The provider perceives; the TypeSafe loop still selects and acts,
 * and host-assigned element ids mean the model cannot address anything it did
 * not actually return.
 */

export class VisionGroundingError extends Schema.TaggedError<VisionGroundingError>()(
  "VisionGroundingError",
  { message: Schema.String },
) {}

export interface VisionGroundingImage {
  readonly mimeType: "image/png";
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

/**
 * One provider call: an image plus a prompt, returning the parsed model JSON.
 * The server backs this with the ordinary provider layer; tests back it with
 * a fixture.
 */
export interface VisionImageInterpreter {
  readonly interpret: (input: {
    readonly prompt: string;
    readonly image: VisionGroundingImage;
  }) => Effect.Effect<unknown, VisionGroundingError>;
}

export interface ObserveVisionDesktopInput {
  readonly interpreter: VisionImageInterpreter;
  readonly capture: () => Effect.Effect<DesktopUseFrame, VisionGroundingError>;
  readonly goal: string;
  readonly maxElements?: number;
  readonly title?: string;
}

export const observeVisionDesktop = (
  input: ObserveVisionDesktopInput,
): Effect.Effect<ComputerSurface, VisionGroundingError> =>
  Effect.gen(function* () {
    const frame = yield* input.capture();
    const dimensions = { width: frame.width, height: frame.height };
    const prompt = buildVisionGroundingPrompt({
      goal: input.goal,
      frame: dimensions,
      ...(input.maxElements === undefined ? {} : { maxElements: input.maxElements }),
    });
    const raw = yield* input.interpreter.interpret({
      prompt,
      image: {
        mimeType: "image/png",
        data: frame.data,
        width: frame.width,
        height: frame.height,
      },
    });
    return yield* Effect.try({
      try: () =>
        parseVisionGrounding(raw, {
          frame: dimensions,
          ...(input.maxElements === undefined ? {} : { maxElements: input.maxElements }),
          ...(input.title === undefined ? {} : { title: input.title }),
        }),
      catch: () =>
        new VisionGroundingError({ message: "The vision model returned an unusable listing." }),
    });
  });

export interface ObserveDesktopWithFallbackInput<E = never> {
  readonly base: () => Effect.Effect<ComputerSurface, E>;
  /** Used only when the base observer yields no actionable element. */
  readonly fallback: () => Effect.Effect<ComputerSurface, E>;
}

/**
 * Accessibility first, vision only when the tree gives nothing to select
 * over. An accessible surface never pays for a vision call, and a canvas
 * surface still produces a bounded catalog instead of failing.
 */
export const observeDesktopWithFallback = <E = never>(
  input: ObserveDesktopWithFallbackInput<E>,
): Effect.Effect<ComputerSurface, E> =>
  input.base().pipe(
    // A failed accessibility read is the strongest case for vision: the
    // surface may exist but be unreadable, so fall back rather than failing.
    Effect.catch(() => input.fallback()),
    Effect.flatMap((surface) =>
      surface.elements.length > 0 ? Effect.succeed(surface) : input.fallback(),
    ),
  );

export const VISION_GROUNDING_MAX = VISION_GROUNDING_MAX_ELEMENTS;
