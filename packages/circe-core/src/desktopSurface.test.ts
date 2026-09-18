import { describe, expect, it } from "vite-plus/test";

import {
  desktopSnapshotIsActionable,
  findDesktopRegion,
  validateDesktopSurfaceAction,
  type DesktopSnapshot,
} from "./desktopSurface.ts";

const snapshot: DesktopSnapshot = {
  capture: {
    captureId: "cap-1",
    displayId: "display-1",
    width: 1000,
    height: 800,
    scale: 1,
    takenAtMs: 1,
    source: "semantic",
  },
  title: "Desktop",
  regions: [
    {
      id: "r1",
      role: "button",
      name: "Save",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      source: "semantic",
      interactive: true,
    },
    {
      id: "r2",
      role: "label",
      name: "Status",
      bounds: { x: 20, y: 0, width: 10, height: 10 },
      source: "semantic",
      interactive: false,
    },
  ],
};

describe("desktop surface action validation", () => {
  it("accepts a click on an offered interactive region", () => {
    expect(
      validateDesktopSurfaceAction(snapshot, { kind: "click", captureId: "cap-1", regionId: "r1" }),
    ).toBeNull();
  });

  it("refuses an action bound to a stale capture", () => {
    expect(
      validateDesktopSurfaceAction(snapshot, { kind: "click", captureId: "cap-0", regionId: "r1" }),
    ).toBe("stale-capture");
  });

  it("refuses an unknown or non-interactive region", () => {
    expect(
      validateDesktopSurfaceAction(snapshot, {
        kind: "click",
        captureId: "cap-1",
        regionId: "nope",
      }),
    ).toBe("unknown-region");
    expect(
      validateDesktopSurfaceAction(snapshot, { kind: "click", captureId: "cap-1", regionId: "r2" }),
    ).toBe("non-interactive-region");
  });

  it("requires text or a key when typing or pressing", () => {
    expect(
      validateDesktopSurfaceAction(snapshot, { kind: "type", captureId: "cap-1", text: "  " }),
    ).toBe("missing-parameter");
    expect(
      validateDesktopSurfaceAction(snapshot, { kind: "press", captureId: "cap-1", key: "" }),
    ).toBe("missing-parameter");
  });

  it("allows typing and scrolling without a target region", () => {
    expect(
      validateDesktopSurfaceAction(snapshot, { kind: "type", captureId: "cap-1", text: "hi" }),
    ).toBeNull();
    expect(
      validateDesktopSurfaceAction(snapshot, {
        kind: "scroll",
        captureId: "cap-1",
        direction: "down",
      }),
    ).toBeNull();
  });
});

describe("desktop surface helpers", () => {
  it("finds regions by id and reports actionability", () => {
    expect(findDesktopRegion(snapshot, "r1")?.name).toBe("Save");
    expect(findDesktopRegion(snapshot, "missing")).toBeUndefined();
    expect(desktopSnapshotIsActionable(snapshot)).toBe(true);
  });

  it("reports a surface with no interactive regions as not actionable", () => {
    expect(
      desktopSnapshotIsActionable({
        ...snapshot,
        regions: snapshot.regions.filter((r) => !r.interactive),
      }),
    ).toBe(false);
  });
});
