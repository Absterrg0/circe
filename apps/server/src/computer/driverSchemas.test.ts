import { describe, expect, it } from "@effect/vitest";

import {
  groundElements,
  observationIsPartial,
  readWindowState,
  readLaunchPid,
  readOnlyText,
} from "./driverSchemas.ts";

describe("driverSchemas", () => {
  it("preserves passive native labels as evidence without inventing action tokens", () => {
    const state = readWindowState({
      tree_markdown:
        '- label = "BLACK STAR"\n- button = "Delete"\n- label = "Search Result"\n- label = "BLACK STAR"\n- label = "bad\\q"',
      elements: [],
    });
    expect(readOnlyText(state!)).toEqual(["BLACK STAR", "Search Result"]);
    expect(groundElements(state!)).toEqual([]);
  });

  it("recognizes GTK editing actions while leaving copy-only text read-only", () => {
    const state = readWindowState({
      elements: [
        {
          element_token: "s1:1",
          role: "search box",
          actions: ["clipboard.cut", "clipboard.copy", "clipboard.paste", "selection.select-all"],
          frame: { x: 0, y: 0, w: 20, h: 20 },
        },
        {
          element_token: "s1:2",
          role: "text box",
          actions: ["clipboard.copy", "selection.select-all"],
          frame: { x: 0, y: 0, w: 20, h: 20 },
        },
      ],
    });
    expect(groundElements(state!).map((element) => element.editable)).toEqual([true, false]);
  });
  it("takes launch identity only from a positive process id", () => {
    expect(readLaunchPid({ pid: 151839, launcher_pid: 999 })).toBe(151839);
    for (const pid of [0, -1, 1.5, "151839", null, undefined])
      expect(readLaunchPid({ pid })).toBeUndefined();
    expect(readLaunchPid({ launcher_pid: 151839 })).toBeUndefined();
  });

  it("keeps valid elements when a structural row has no token or frame", () => {
    const state = readWindowState({
      window_title: "Calculator",
      app_name: "Calculator",
      snapshot_id: "s00000001",
      elements: [
        { role: "frame", label: "Calculator", depth: 0 },
        {
          element_token: "s00000001:1",
          role: "push button",
          label: "5",
          selected: true,
          enabled: true,
          actions: ["click"],
          frame: { x: 10, y: 20, w: 30, h: 30 },
        },
      ],
    });
    expect(state).toBeDefined();
    const grounded = groundElements(state!);
    expect(grounded).toHaveLength(1);
    expect(grounded[0]).toMatchObject({
      token: "s00000001:1",
      name: "5",
      state: "selected,actions:click",
      bounds: { x: 10, y: 20, width: 30, height: 30 },
    });
    // The dropped structural row makes the observation partial, so the
    // planner knows it cannot establish what it cannot see.
    expect(observationIsPartial(state!)).toBe(true);
  });

  it("reports a complete observation as complete", () => {
    const state = readWindowState({
      elements: [
        {
          element_token: "s00000002:0",
          role: "label",
          label: "Ready",
          frame: { x: 0, y: 0, w: 10, h: 10 },
        },
      ],
    });
    expect(state).toBeDefined();
    expect(observationIsPartial(state!)).toBe(false);
  });

  it("treats a malformed payload as no observation", () => {
    expect(readWindowState({ elements: "nope" })).toBeUndefined();
  });
});
