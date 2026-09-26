import { describe, expect, it } from "@effect/vitest";

import { groundElements, observationIsPartial, readWindowState } from "./driverSchemas.ts";

describe("driverSchemas", () => {
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
