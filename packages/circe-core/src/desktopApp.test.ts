import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopApp, scopeSurfaceToApp } from "./desktopApp.ts";

const running = ["gnome-shell", "gnome-calculator", "gnome-text-editor", "org.gnome.Nautilus"];

describe("desktop app resolution", () => {
  it("resolves an alias to a running app", () => {
    expect(resolveDesktopApp("click Recent Files in the file manager", running)).toBe(
      "org.gnome.Nautilus",
    );
    expect(resolveDesktopApp("add two numbers in the calculator", running)).toBe(
      "gnome-calculator",
    );
    expect(resolveDesktopApp("type a note in the text editor", running)).toBe("gnome-text-editor");
  });

  it("prefers the app's own name in the goal", () => {
    expect(resolveDesktopApp("open gnome-text-editor", running)).toBe("gnome-text-editor");
  });

  it("resolves nothing when the goal names no app or an app that is not running", () => {
    expect(resolveDesktopApp("press escape", running)).toBeUndefined();
    expect(resolveDesktopApp("open firefox", running)).toBeUndefined();
    expect(resolveDesktopApp("file manager", [])).toBeUndefined();
  });

  it("scopes a surface to one app while keeping unowned window frames", () => {
    const elements = [
      { id: "1", role: "frame", name: "Home", app: "org.gnome.Nautilus" },
      { id: "2", role: "push button", name: "Close", app: "gnome-calculator" },
      { id: "3", role: "frame", name: "Desktop", app: undefined },
      { id: "4", role: "row", name: "Recent Files", app: "org.gnome.Nautilus" },
    ];
    expect(scopeSurfaceToApp(elements, "org.gnome.Nautilus").map((element) => element.id)).toEqual([
      "1",
      "3",
      "4",
    ]);
  });
});

describe("goal-scoped surface ranking", () => {
  it("keeps the elements the goal names ahead of unrelated ones", async () => {
    const { rankSurfaceForGoal } = await import("./desktopApp.ts");
    const elements = [
      { id: "f", role: "frame", name: "Home", app: "org.gnome.Nautilus" },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `x${index}`,
        role: "list item",
        name: `File ${index}`,
        app: "org.gnome.Nautilus",
      })),
      { id: "r", role: "list item", name: "Recent Files", app: "org.gnome.Nautilus" },
      { id: "s", role: "list item", name: "Starred Files", app: "org.gnome.Nautilus" },
    ];
    const ranked = rankSurfaceForGoal(
      elements,
      "click the Recent Files item in the file manager sidebar",
      8,
    );
    const ids = ranked.map((element) => element.id);
    expect(ids).toContain("r");
    expect(ids).toContain("f");
    expect(ids).not.toContain("x39");
  });
});
