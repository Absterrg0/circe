import { describe, expect, it } from "vite-plus/test";

import { buildVisionGroundingPrompt, parseVisionGrounding } from "./visionGrounding.ts";

const frame = { width: 1000, height: 800 };

describe("vision grounding prompt", () => {
  it("states the frame, the goal, and a bounded JSON contract", () => {
    const prompt = buildVisionGroundingPrompt({ goal: "click save", frame, maxElements: 12 });
    expect(prompt).toContain("1000 by 800");
    expect(prompt).toContain("click save");
    expect(prompt).toContain("at most 12");
    expect(prompt).toContain("Return only JSON");
  });
});

describe("vision grounding parse", () => {
  it("assigns host ids and keeps valid elements", () => {
    const surface = parseVisionGrounding(
      {
        elements: [
          { role: "button", name: "Save", x: 10, y: 20, width: 80, height: 24 },
          { role: "textbox", name: "Search", x: 100, y: 40, width: 200, height: 30 },
        ],
      },
      { frame },
    );
    expect(surface.elements.map((element) => element.id)).toEqual(["vision:0", "vision:1"]);
    expect(surface.elements[0]).toEqual({
      id: "vision:0",
      role: "button",
      name: "Save",
      bounds: { x: 10, y: 20, width: 80, height: 24 },
    });
  });

  it("clamps to the frame and drops tiny or fully off-frame boxes", () => {
    const surface = parseVisionGrounding(
      {
        elements: [
          { role: "button", name: "Edge", x: 980, y: 780, width: 100, height: 100 },
          { role: "button", name: "Tiny", x: 0, y: 0, width: 2, height: 2 },
          { role: "button", name: "Off", x: 2000, y: 2000, width: 50, height: 50 },
        ],
      },
      { frame },
    );
    expect(surface.elements.map((element) => element.name)).toEqual(["Edge"]);
    expect(surface.elements[0]?.bounds).toEqual({ x: 980, y: 780, width: 20, height: 20 });
  });

  it("drops nameless, roleless entries and dedupes identical boxes", () => {
    const surface = parseVisionGrounding(
      {
        elements: [
          { name: "", x: 0, y: 0, width: 50, height: 50 },
          { role: "button", name: "OK", x: 5, y: 5, width: 40, height: 20 },
          { role: "button", name: "OK", x: 5, y: 5, width: 40, height: 20 },
        ],
      },
      { frame },
    );
    expect(surface.elements.map((element) => element.name)).toEqual(["OK"]);
    expect(surface.elements).toHaveLength(1);
  });

  it("honors the element cap", () => {
    const elements = Array.from({ length: 10 }, (_, index) => ({
      role: "button",
      name: `B${index}`,
      x: index * 10,
      y: 0,
      width: 20,
      height: 20,
    }));
    const surface = parseVisionGrounding({ elements }, { frame, maxElements: 3 });
    expect(surface.elements).toHaveLength(3);
  });

  it("rejects malformed output instead of inventing a catalog", () => {
    expect(() => parseVisionGrounding({ elements: [{ role: "button" }] }, { frame })).toThrow();
  });
});
