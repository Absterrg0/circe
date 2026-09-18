import type { PreviewAutomationElement } from "@circe/contracts";
import { describe, expect, it } from "vite-plus/test";

import { browserOperationForAction, browserSurfaceFromSnapshot } from "./browserUse.ts";

const element = (
  selector: string,
  role: string | null,
  name: string,
): PreviewAutomationElement => ({
  tag: "button",
  role,
  name,
  selector,
  x: 1,
  y: 2,
  width: 30,
  height: 12,
});

const snapshot = {
  title: "Inbox",
  url: "https://mail.example.com",
  visibleText: "Compose Search",
  interactiveElements: [
    element("role=button[name='Compose']", "button", "Compose"),
    element("role=textbox[name='Search']", "textbox", "Search"),
    element("role=button[name='Compose']", "button", "Compose"),
  ],
};

describe("browser surface grounding", () => {
  it("maps grounded elements and drops duplicate selectors", () => {
    const surface = browserSurfaceFromSnapshot(snapshot);
    expect(surface.kind).toBe("browser");
    expect(surface.elements.map((entry) => entry.id)).toEqual([
      "role=button[name='Compose']",
      "role=textbox[name='Search']",
    ]);
    expect(surface.elements[0]?.bounds).toEqual({ x: 1, y: 2, width: 30, height: 12 });
  });

  it("honors the element cap", () => {
    const surface = browserSurfaceFromSnapshot(snapshot, { maxElements: 1 });
    expect(surface.elements).toHaveLength(1);
  });
});

describe("browser operation mapping", () => {
  it("targets the grounded selector, never a coordinate", () => {
    expect(
      browserOperationForAction({ kind: "click", elementId: "role=button[name='Compose']" }),
    ).toEqual({ operation: "click", input: { locator: "role=button[name='Compose']" } });
  });

  it("types into a grounded field and into the focused field when omitted", () => {
    expect(
      browserOperationForAction({
        kind: "type",
        elementId: "role=textbox[name='Search']",
        text: "hello",
      }),
    ).toEqual({
      operation: "type",
      input: { text: "hello", locator: "role=textbox[name='Search']" },
    });
    expect(browserOperationForAction({ kind: "type", text: "hello" })).toEqual({
      operation: "type",
      input: { text: "hello" },
    });
  });

  it("maps scroll directions to signed deltas", () => {
    expect(browserOperationForAction({ kind: "scroll", direction: "down" })).toEqual({
      operation: "scroll",
      input: { deltaY: 600 },
    });
    expect(browserOperationForAction({ kind: "scroll", direction: "left" })).toEqual({
      operation: "scroll",
      input: { deltaX: -600 },
    });
  });

  it("returns no operation for wait", () => {
    expect(browserOperationForAction({ kind: "wait" })).toBeNull();
  });
});
