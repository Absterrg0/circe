import { describe, expect, it } from "vite-plus/test";

import { PROJECT_BREADCRUMB_BUTTON_CLASS, resolveRenameCommit } from "./ChatHeader";

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});

describe("PROJECT_BREADCRUMB_BUTTON_CLASS", () => {
  it("expands the coarse-pointer hit area to 44px without growing the desktop layout", () => {
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("relative");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("pointer-coarse:after:absolute");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("pointer-coarse:after:size-full");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("pointer-coarse:after:min-h-11");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("pointer-coarse:after:min-w-11");
  });

  it("keeps the compact inline desktop presentation", () => {
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("inline-flex");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).toContain("min-w-0");
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).not.toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(PROJECT_BREADCRUMB_BUTTON_CLASS).not.toMatch(/(^|\s)h-11(\s|$)/);
  });
});
