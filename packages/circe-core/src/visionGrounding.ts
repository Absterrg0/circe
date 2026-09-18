import * as Schema from "effect/Schema";

import type { ComputerElement, ComputerSurface } from "./computerUse.ts";

/**
 * The vision grounding producer. When a surface has no usable accessibility
 * tree (canvas, GL, games), a multimodal model turns a screenshot into a
 * bounded text catalog of actionable elements. That catalog is the only thing
 * the TypeSafe step layer sees: the model perceives, the host validates, and
 * the loop still selects among finite elements. The model never emits an
 * action, a selector, or an address, and it never drives the loop.
 *
 * Every element id is assigned by the host, not the model, so a hallucinated
 * id cannot address anything that was not returned in this catalog.
 */

export const VISION_GROUNDING_MAX_ELEMENTS = 60;
export const VISION_GROUNDING_MIN_SIDE = 4;

const VisionElementRaw = Schema.Struct({
  role: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

const VisionGroundingRaw = Schema.Struct({
  elements: Schema.Array(VisionElementRaw),
});

const decodeVisionGrounding = Schema.decodeUnknownSync(VisionGroundingRaw);

export interface VisionGroundingFrame {
  readonly width: number;
  readonly height: number;
}

export interface BuildVisionGroundingPromptInput {
  readonly goal: string;
  readonly frame: VisionGroundingFrame;
  readonly maxElements?: number;
}

/**
 * One plain instruction asking for a bounded element list in image pixels.
 * The output contract is deliberately tiny so a vision model cannot smuggle
 * prose, coordinates outside the image, or an action.
 */
export function buildVisionGroundingPrompt(input: BuildVisionGroundingPromptInput): string {
  const maxElements = input.maxElements ?? VISION_GROUNDING_MAX_ELEMENTS;
  return [
    "You are the perception stage for a desktop agent. You do not act.",
    `The screenshot is ${input.frame.width} by ${input.frame.height} pixels.`,
    `List the interactive or clearly labeled UI elements that matter for this goal: ${input.goal}`,
    "Return only JSON, no prose and no markdown fences, in exactly this shape:",
    '{"elements":[{"role":"button","name":"Save","x":0,"y":0,"width":0,"height":0}]}',
    `Coordinates are image pixels with the origin at the top-left of the screenshot.`,
    `Return at most ${maxElements} elements, most relevant first.`,
    "Use an empty name when the element has no label. Never invent elements that are not visible.",
  ].join("\n");
}

export interface ParseVisionGroundingOptions {
  readonly frame: VisionGroundingFrame;
  readonly maxElements?: number;
  readonly title?: string;
}

/**
 * Validate one model listing into a bounded surface. Elements are clamped to
 * the frame, tiny or fully off-frame boxes are dropped, ids are host-assigned,
 * and duplicates by role/name/bounds are removed. Malformed output throws so
 * the caller can escalate rather than act on an invented catalog.
 */
export function parseVisionGrounding(
  raw: unknown,
  options: ParseVisionGroundingOptions,
): ComputerSurface {
  const decoded = decodeVisionGrounding(raw);
  const maxElements = options.maxElements ?? VISION_GROUNDING_MAX_ELEMENTS;
  const { width: frameWidth, height: frameHeight } = options.frame;
  const seen = new Set<string>();
  const elements: Array<ComputerElement> = [];
  for (const entry of decoded.elements) {
    const left = Math.max(0, Math.min(entry.x, frameWidth));
    const top = Math.max(0, Math.min(entry.y, frameHeight));
    const right = Math.max(0, Math.min(entry.x + entry.width, frameWidth));
    const bottom = Math.max(0, Math.min(entry.y + entry.height, frameHeight));
    const width = right - left;
    const height = bottom - top;
    if (width < VISION_GROUNDING_MIN_SIDE || height < VISION_GROUNDING_MIN_SIDE) continue;
    const role = entry.role ?? null;
    const name = (entry.name ?? "").trim().slice(0, 200);
    if (role === null && name.length === 0) continue;
    const key = `${role ?? ""}\u0000${name}\u0000${left}\u0000${top}\u0000${width}\u0000${height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({
      // Host-assigned: the model cannot address an element it did not return.
      id: `vision:${elements.length}`,
      role,
      name,
      bounds: { x: left, y: top, width, height },
    });
    if (elements.length >= maxElements) break;
  }
  return {
    kind: "desktop",
    title: options.title ?? "Desktop (vision)",
    elements,
  };
}
