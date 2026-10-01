import type { ComputerHostToolResult } from "@circe/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeCoreDesktopHost, receiptOf } from "./coreDesktopHost.ts";

const result = (
  effect: ComputerHostToolResult["effect"],
  structured?: unknown,
  isError = false,
  driverCode?: string,
): ComputerHostToolResult => ({
  isError,
  degraded: false,
  effect,
  text: "",
  ...(structured === undefined ? {} : { structured }),
  ...(driverCode === undefined ? {} : { driverCode }),
  images: [],
});

const window = { window_id: 9, pid: 7, app_name: "Drawn", title: "Drawn", is_on_screen: true };

/** A window with no accessible controls, so every observation reads its capture. */
const makeHost = (clickResult: ComputerHostToolResult = result("dispatched-unknown")) => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  let capture = 0;
  const host = makeCoreDesktopHost({
    platform: "linux",
    visualAvailable: Effect.succeed(true),
    run: Effect.runPromise,
    call: (tool, args) =>
      Effect.sync(() => {
        calls.push({ tool, args });
        switch (tool) {
          case "list_apps":
            return result("verified", {
              apps: [
                { pid: 7, name: "drawn-bin", running: true, kind: null },
                { pid: 0, name: "Drawn", running: false, kind: "desktop", launch_path: "drawn" },
                { pid: 0, name: "Notes", running: false, kind: "desktop", launch_path: "notes" },
                { pid: 12, name: "gsd-xsettings", running: true, kind: null },
              ],
            });
          case "list_windows":
            return result("verified", { windows: [window] });
          case "get_window_state":
            capture += args.include_screenshot === true ? 1 : 0;
            return result("verified", {
              pid: 7,
              window_id: 9,
              app_name: "Drawn",
              window_title: "Drawn",
              snapshot_id: `s${calls.length}`,
              ...(args.include_screenshot === true
                ? { capture_id: `c${capture}`, screenshot_width: 100, screenshot_height: 100 }
                : {}),
              elements: [
                {
                  element_token: `s${calls.length}:0`,
                  role: "window",
                  label: "Drawn",
                  frame: { x: 0, y: 0, w: 100, h: 100 },
                },
              ],
            });
          case "parse_visual_regions":
            return result("verified", {
              schema: "cua.visual_regions_v1",
              capture: {
                capture_id: `c${capture}`,
                source: { kind: "window", pid: 7, window_id: 9 },
                screenshot: {
                  mime_type: "image/png",
                  reference: "png-sha256:abc",
                  width: 100,
                  height: 100,
                },
                action_coordinate_space: { kind: "screenshot_pixels" },
              },
              regions: [
                {
                  id: "r1",
                  kind: "text",
                  text: "Save",
                  confidence: 0.9,
                  interactive: false,
                  bounds: { x: 10, y: 10, width: 20, height: 10 },
                },
              ],
            });
          case "click":
            return clickResult;
          default:
            return result("verified");
        }
      }),
  });
  return { host, calls };
};

describe("circe-core's view of this desktop", () => {
  it("keeps the installed app identity when launch metadata uses a document title", async () => {
    const host = makeCoreDesktopHost({
      platform: "linux",
      visualAvailable: Effect.succeed(false),
      run: Effect.runPromise,
      call: (tool) =>
        Effect.succeed(
          tool === "list_apps"
            ? result("verified", {
                apps: [
                  { pid: 0, name: "Notes", running: false, kind: "desktop", launch_path: "notes" },
                ],
              })
            : tool === "launch_app"
              ? result("dispatched-unknown", {
                  pid: 12,
                  windows: [
                    {
                      ...window,
                      pid: 12,
                      app_name: "draft.txt - Notes",
                      title: "draft.txt - Notes",
                    },
                  ],
                })
              : result("verified", { windows: [] }),
        ),
    });
    const [app] = await host.apps();
    const launched = await host.launch(app!);
    expect(launched.window?.app).toBe("Notes");
    expect(launched.window?.title).toBe("draft.txt - Notes");
  });

  it("lists a running app by its window and installed apps by name, without process noise", async () => {
    const { host } = makeHost();
    const apps = await host.apps();
    expect(apps.map((app) => [app.name, app.running, app.windows.length])).toEqual([
      ["Drawn", true, 1],
      ["Notes", false, 0],
    ]);
  });

  it("names a window that reports its process name after the installed app, so it is reused", async () => {
    const host = makeCoreDesktopHost({
      platform: "linux",
      visualAvailable: Effect.succeed(false),
      run: Effect.runPromise,
      call: (tool) =>
        Effect.sync(() =>
          tool === "list_windows"
            ? result("verified", {
                windows: [
                  {
                    window_id: 3,
                    pid: 50,
                    app_name: "gnome-calculator",
                    title: "Calculator",
                    is_on_screen: true,
                  },
                ],
              })
            : result("verified", {
                apps: [
                  { pid: 50, name: "gnome-calculator", running: true, kind: null },
                  {
                    pid: 0,
                    name: "Calculator",
                    running: false,
                    kind: "desktop",
                    launch_path: "gnome-calculator",
                    bundle_id: "org.gnome.Calculator",
                  },
                  {
                    pid: 0,
                    name: "LibreOffice Calc",
                    running: false,
                    kind: "desktop",
                    launch_path: "libreoffice --calc",
                  },
                ],
              }),
        ),
    });
    const apps = await host.apps();
    expect(apps.map((app) => [app.name, app.running])).toEqual([
      ["Calculator", true],
      ["LibreOffice Calc", false],
    ]);
    expect(apps[0]?.windows[0]).toMatchObject({ app: "Calculator", title: "Calculator" });
  });

  it("reads each driver result as honest delivery", () => {
    expect(receiptOf(result("verified")).delivery).toBe("confirmed");
    expect(receiptOf(result("dispatched-unknown")).delivery).toBe("delivered");
    expect(receiptOf(result("dispatched-unknown", undefined, true)).delivery).toBe("unknown");
    expect(receiptOf(result("refused", undefined, true)).delivery).toBe("not-delivered");
    expect(receiptOf(result("not-dispatched", undefined, true)).delivery).toBe("not-delivered");
  });

  it("delivers nothing for a view that is no longer current", async () => {
    const { host, calls } = makeHost();
    const [drawn] = await host.apps();
    const first = await host.observe(drawn!.windows[0]!);
    await host.observe(drawn!.windows[0]!);
    const save = first.controls.find((control) => control.name === "Save");
    expect(save?.source).toBe("visual");
    const receipt = await host.act(first, { kind: "click", control: save!.id });
    expect(receipt.delivery).toBe("not-delivered");
    expect(calls.some((call) => call.tool === "click")).toBe(false);
  });

  it("clicks a point read from the screen once, bound to its capture", async () => {
    const { host, calls } = makeHost();
    const [drawn] = await host.apps();
    const view = await host.observe(drawn!.windows[0]!);
    const save = view.controls.find((control) => control.name === "Save")!;
    expect((await host.act(view, { kind: "click", control: save.id })).delivery).toBe("delivered");
    expect(calls.find((call) => call.tool === "click")?.args).toMatchObject({
      pid: 7,
      window_id: 9,
      capture_id: "c1",
      delivery_mode: "background",
    });
    // The same view never authorizes a second action.
    expect((await host.act(view, { kind: "click", control: save.id })).delivery).toBe(
      "not-delivered",
    );
    expect(calls.filter((call) => call.tool === "click")).toHaveLength(1);
  });

  it("never types into a point read from the screen", async () => {
    const { host, calls } = makeHost();
    const [drawn] = await host.apps();
    const view = await host.observe(drawn!.windows[0]!);
    const save = view.controls.find((control) => control.name === "Save")!;
    expect((await host.act(view, { kind: "type", control: save.id, text: "x" })).delivery).toBe(
      "not-delivered",
    );
    expect(calls.some((call) => call.tool === "type_text" || call.tool === "set_value")).toBe(
      false,
    );
  });

  it("replaces a native field value instead of appending text", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const host = makeCoreDesktopHost({
      platform: "linux",
      visualAvailable: Effect.succeed(false),
      run: Effect.runPromise,
      call: (tool, args) =>
        Effect.sync(() => {
          calls.push({ tool, args });
          if (tool === "list_windows") return result("verified", { windows: [window] });
          if (tool === "get_window_state")
            return result("verified", {
              pid: 7,
              window_id: 9,
              snapshot_id: "s1",
              elements: [
                {
                  element_token: "s1:1",
                  role: "text box",
                  label: "",
                  value: "50",
                  editable: true,
                  frame: { x: 0, y: 0, w: 50, h: 20 },
                },
              ],
            });
          return result("verified", { apps: [] });
        }),
    });
    const [app] = await host.apps();
    const view = await host.observe(app!.windows[0]!);
    const field = view.controls.find((control) => control.role === "text box")!;
    expect((await host.act(view, { kind: "type", control: field.id, text: "50+3" })).delivery).toBe(
      "confirmed",
    );
    expect(calls.filter((call) => call.tool === "set_value")).toEqual([
      {
        tool: "set_value",
        args: {
          pid: 7,
          window_id: 9,
          element_token: "s1:1",
          value: "50+3",
          delivery_mode: "background",
        },
      },
    ]);
    expect(calls.some((call) => call.tool === "type_text")).toBe(false);
    const fresh = await host.observe(app!.windows[0]!);
    await host.act(fresh, { kind: "key", control: field.id, key: "enter" });
    expect(calls.find((call) => call.tool === "press_key")?.args).toMatchObject({
      pid: 7,
      window_id: 9,
      element_token: "s1:1",
      key: "enter",
      delivery_mode: "background",
    });
  });

  it("sends nothing once the goal is stopped", async () => {
    let stopped = false;
    const calls: string[] = [];
    const host = makeCoreDesktopHost({
      platform: "linux",
      visualAvailable: Effect.succeed(false),
      run: Effect.runPromise,
      stopped: Effect.sync(() => stopped),
      onStopped: () => calls.push("stopped"),
      call: (tool) =>
        Effect.sync(() => {
          calls.push(tool);
          return tool === "list_windows"
            ? result("verified", { windows: [window] })
            : tool === "get_window_state"
              ? result("verified", {
                  pid: 7,
                  window_id: 9,
                  snapshot_id: "s1",
                  elements: [
                    {
                      element_token: "s1:1",
                      role: "button",
                      label: "Go",
                      frame: { x: 0, y: 0, w: 5, h: 5 },
                    },
                  ],
                })
              : result("verified", { apps: [] });
        }),
    });
    const [app] = await host.apps();
    const view = await host.observe(app!.windows[0]!);
    stopped = true;
    const receipt = await host.act(view, { kind: "click", control: "s1:1" });
    expect(receipt.delivery).toBe("not-delivered");
    expect(calls).not.toContain("click");
    expect(calls).toContain("stopped");
  });
});
