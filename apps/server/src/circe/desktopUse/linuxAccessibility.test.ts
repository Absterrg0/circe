import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  accessibilityElements,
  decodeAccessibilityTree,
  desktopSurfaceFromAccessibility,
  observeLinuxDesktop,
  parseAccessibilityDump,
} from "./linuxAccessibility.ts";

const tree = decodeAccessibilityTree({
  elements: [
    {
      id: "app:0/0",
      role: "frame",
      name: "Editor",
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      editable: false,
      actions: ["default.activate", "window.close"],
    },
    {
      id: "app:0/0/3",
      role: "push button",
      name: "Save",
      bounds: { x: 700, y: 40, width: 80, height: 24 },
      editable: false,
      actions: ["click"],
    },
    {
      id: "app:0/0/5",
      role: "entry",
      name: "Search",
      bounds: { x: 100, y: 40, width: 200, height: 24 },
      editable: true,
      actions: [],
    },
    {
      id: "app:0/0/3",
      role: "push button",
      name: "Save",
      bounds: { x: 700, y: 40, width: 80, height: 24 },
      editable: false,
      actions: ["click"],
    },
  ],
});

describe("linux accessibility grounding", () => {
  it("maps grounded elements and dedupes by id", () => {
    const elements = accessibilityElements(tree);
    expect(elements.map((element) => element.id)).toEqual(["app:0/0", "app:0/0/3", "app:0/0/5"]);
    expect(elements[1]).toEqual({
      id: "app:0/0/3",
      role: "push button",
      name: "Save",
      bounds: { x: 700, y: 40, width: 80, height: 24 },
    });
  });

  it("honors the element cap", () => {
    expect(accessibilityElements(tree, 2)).toHaveLength(2);
  });

  it("builds a desktop surface for the step layer", () => {
    const surface = desktopSurfaceFromAccessibility(tree, { title: "Editor" });
    expect(surface.kind).toBe("desktop");
    expect(surface.title).toBe("Editor");
    expect(surface.elements).toHaveLength(3);
  });

  it("rejects a malformed tree instead of inventing elements", () => {
    expect(() => decodeAccessibilityTree({ elements: [{ id: "x" }] })).toThrow();
  });

  it("parses a helper dump and maps it to a surface", () => {
    const dump = JSON.stringify({
      elements: [
        {
          id: "app:0/1",
          role: "push button",
          name: "OK",
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          editable: false,
          actions: ["click"],
        },
      ],
    });
    const surface = desktopSurfaceFromAccessibility(parseAccessibilityDump(dump));
    expect(surface.elements.map((element) => element.id)).toEqual(["app:0/1"]);
  });

  it("observes the desktop through the command runner", () => {
    const surface = Effect.runSync(
      observeLinuxDesktop(
        () =>
          Effect.succeed({
            stdout: JSON.stringify({
              elements: [
                {
                  id: "app:1/0",
                  role: "frame",
                  name: "Terminal",
                  bounds: { x: 0, y: 0, width: 100, height: 100 },
                  editable: false,
                  actions: ["window.close"],
                },
              ],
            }),
          }),
        { title: "Desktop" },
      ),
    );
    expect(surface.kind).toBe("desktop");
    expect(surface.elements[0]?.name).toBe("Terminal");
  });
});
