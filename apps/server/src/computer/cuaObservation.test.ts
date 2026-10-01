import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  hasApplicationElements,
  readVisualRegions,
  visualFallbackReason,
  VisualObservationError,
} from "./cuaObservation.ts";

const result = (overrides: Record<string, unknown> = {}) => ({
  schema: "cua.visual_regions_v1",
  capture: {
    capture_id: "cap-1",
    source: { kind: "window", pid: 42, window_id: 7 },
    screenshot: { mime_type: "image/png", reference: "png-sha256:x", width: 100, height: 50 },
    action_coordinate_space: { kind: "screenshot_pixels" },
  },
  regions: [
    {
      id: "text-1",
      kind: "text",
      text: "Send",
      confidence: 0.7,
      interactive: false,
      bounds: { x: 10, y: 10, width: 20, height: 10 },
    },
  ],
  ...overrides,
});
const expected = { captureId: "cap-1", pid: 42, windowId: 7, width: 100, height: 50 };

const isRejection = Schema.is(VisualObservationError);
const code = (value: unknown) => (isRejection(value) ? value.code : "ok");

describe("readVisualRegions", () => {
  it("accepts a result bound to the requesting capture and window", () => {
    const parsed = readVisualRegions(result(), expected);
    expect(code(parsed)).toBe("ok");
    expect(isRejection(parsed) ? [] : parsed.regions).toHaveLength(1);
  });

  it("rejects a result for another capture or window", () => {
    expect(code(readVisualRegions(result(), { ...expected, captureId: "cap-2" }))).toBe(
      "capture_mismatch",
    );
    expect(code(readVisualRegions(result(), { ...expected, pid: 43 }))).toBe("capture_mismatch");
    expect(code(readVisualRegions(result(), { ...expected, windowId: 8 }))).toBe(
      "capture_mismatch",
    );
    expect(code(readVisualRegions(result(), { ...expected, width: 200 }))).toBe("capture_mismatch");
  });

  it("rejects malformed results whole", () => {
    const base = result();
    const cases: Array<unknown> = [
      { ...base, schema: "cua.visual_regions_v2" },
      {
        ...base,
        capture: {
          ...base.capture,
          action_coordinate_space: { kind: "affine", m11: 0, m12: 0, m21: 0, m22: 0, tx: 0, ty: 0 },
        },
      },
      { ...base, regions: [...base.regions, base.regions[0]] },
      {
        ...base,
        regions: [{ ...base.regions[0], bounds: { x: 90, y: 10, width: 20, height: 10 } }],
      },
      { ...base, regions: [{ ...base.regions[0], confidence: 1.5 }] },
      { ...base, regions: [{ ...base.regions[0], text: null }] },
      { ...base, regions: [{ ...base.regions[0], kind: "button" }] },
      null,
    ];
    for (const payload of cases)
      expect(code(readVisualRegions(payload, expected))).toBe("invalid_visual_result");
  });
});

describe("native fallback policy", () => {
  const root = { element_index: 0, role: "window", label: "App" };

  it("finds no application content in window roots and window chrome", () => {
    expect(hasApplicationElements([root], "linux")).toBe(false);
    expect(
      hasApplicationElements(
        [
          root,
          { element_index: 1, parent_index: 0, role: "TitleBar" },
          { element_index: 2, parent_index: 1, role: "Button", label: "Close" },
        ],
        "windows",
      ),
    ).toBe(false);
    expect(
      hasApplicationElements(
        [
          root,
          { element_index: 1, parent_index: 0, role: "AXMenuBar" },
          { element_index: 2, parent_index: 1, role: "AXMenuBarItem", label: "File" },
          { element_index: 3, parent_index: 0, role: "AXButton" },
        ],
        "macos",
      ),
    ).toBe(false);
    expect(
      hasApplicationElements(
        [root, { element_index: 1, parent_index: 0, role: "push button", label: "Send" }],
        "linux",
      ),
    ).toBe(true);
  });

  it("reobserves a truncated tree instead of falling back", () => {
    expect(visualFallbackReason({ truncated: true, elements: [root] }, "linux", 0)).toBeUndefined();
  });

  it("falls back for an empty tree, chrome only, or no actionable controls", () => {
    expect(
      visualFallbackReason(
        { degraded: true, degraded_reason: "ax_tree_empty: none", elements: [] },
        "linux",
        0,
      ),
    ).toBe("tree_empty");
    expect(visualFallbackReason({ elements_complete: false, elements: [root] }, "linux", 0)).toBe(
      "no_application_elements",
    );
    expect(visualFallbackReason({ elements_complete: true, elements: [root] }, "linux", 0)).toBe(
      "no_native_candidates",
    );
  });

  it("keeps native grounding for a partial tree with application controls", () => {
    expect(
      visualFallbackReason(
        {
          elements_complete: false,
          elements: [
            root,
            { element_index: 1, parent_index: 0, role: "push button", label: "Send" },
          ],
        },
        "linux",
        1,
      ),
    ).toBeUndefined();
  });
});
