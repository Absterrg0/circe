import type { DesktopUseFrame } from "@circe/contracts";
import type { ComputerSurface } from "@circe/core/computerUse";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  observeDesktopWithFallback,
  observeVisionDesktop,
  VisionGroundingError,
  type VisionImageInterpreter,
} from "./visionGrounding.ts";

const frame: DesktopUseFrame = {
  displayId: "display-1",
  width: 1000,
  height: 800,
  scale: 1,
  mimeType: "image/png",
  data: "AAAA",
  capturedAt: 1,
};

const listing = {
  elements: [{ role: "button", name: "Save", x: 10, y: 20, width: 80, height: 24 }],
};

describe("vision grounding observer", () => {
  it("sends the goal and frame to the interpreter and maps the listing", () => {
    let seenPrompt = "";
    const interpreter: VisionImageInterpreter = {
      interpret: (input) => {
        seenPrompt = input.prompt;
        expect(input.image.width).toBe(1000);
        return Effect.succeed(listing);
      },
    };
    const surface = Effect.runSync(
      observeVisionDesktop({
        interpreter,
        capture: () => Effect.succeed(frame),
        goal: "save the document",
      }),
    );
    expect(seenPrompt).toContain("save the document");
    expect(seenPrompt).toContain("1000 by 800");
    expect(surface.elements).toHaveLength(1);
    expect(surface.elements[0]?.id).toBe("vision:0");
  });

  it("fails when the model returns unusable output instead of inventing a catalog", () => {
    const exit = Effect.runSyncExit(
      observeVisionDesktop({
        interpreter: { interpret: () => Effect.succeed({ nope: true }) },
        capture: () => Effect.succeed(frame),
        goal: "save",
      }),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("observeDesktopWithFallback", () => {
  const surfaceWith = (count: number): ComputerSurface => ({
    kind: "desktop",
    title: "Desktop",
    elements:
      count === 0
        ? []
        : [
            {
              id: "vision:0",
              role: "button",
              name: "Save",
              bounds: { x: 0, y: 0, width: 10, height: 10 },
            },
          ],
  });

  it("does not call vision when the accessibility tree has elements", () => {
    let fallbackCalls = 0;
    const surface = Effect.runSync(
      observeDesktopWithFallback({
        base: () => Effect.succeed(surfaceWith(1)),
        fallback: () => {
          fallbackCalls += 1;
          return Effect.succeed(surfaceWith(0));
        },
      }),
    );
    expect(surface.elements).toHaveLength(1);
    expect(fallbackCalls).toBe(0);
  });

  it("uses vision when the accessibility tree is empty", () => {
    let fallbackCalls = 0;
    const surface = Effect.runSync(
      observeDesktopWithFallback({
        base: () => Effect.succeed(surfaceWith(0)),
        fallback: () => {
          fallbackCalls += 1;
          return Effect.succeed(surfaceWith(1));
        },
      }),
    );
    expect(surface.elements).toHaveLength(1);
    expect(fallbackCalls).toBe(1);
  });
});

describe("vision grounding error", () => {
  it("carries a message", () => {
    const error = new VisionGroundingError({ message: "nope" });
    expect(error.message).toBe("nope");
  });
});
