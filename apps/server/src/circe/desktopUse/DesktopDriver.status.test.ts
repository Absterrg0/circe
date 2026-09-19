import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@circe/shared/hostProcess";
import type { DesktopUseBackend } from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import { DesktopCommands } from "./DesktopCommands.ts";
import * as DesktopDriverModule from "./DesktopDriver.ts";
import type { DesktopCommand } from "./platforms.ts";

const displayCatalog = JSON.stringify([
  { id: "eDP-1", x: 0, y: 0, scale: 1, primary: true, width: 1920, height: 1080 },
]);

const elementDump = JSON.stringify({
  elements: [
    {
      id: "app:0/0/1",
      role: "entry",
      name: "Search",
      bounds: { x: 10, y: 20, width: 300, height: 40 },
      editable: true,
      actions: [],
    },
  ],
});

const recorded: Array<ReadonlyArray<string>> = [];

/**
 * A GNOME Wayland node with gjs but no screenshot or input helper, which is
 * exactly the machine this behavior was wrong on: the driver reported the whole
 * desktop as unavailable even though AT-SPI can ground and act on elements.
 */
const fakeCommands = (options: { readonly accessibility: boolean }) =>
  Layer.succeed(
    DesktopCommands,
    DesktopCommands.of({
      run: (spec: DesktopCommand, _backend: DesktopUseBackend) => {
        recorded.push([spec.command, ...spec.args]);
        if (spec.command === "sh") return Effect.succeed({ code: 0, stdout: "gjs", stderr: "" });
        if (spec.command === "gjs")
          return Effect.succeed({ code: 0, stdout: displayCatalog, stderr: "" });
        if (spec.command === "python3") {
          if (!options.accessibility)
            return Effect.succeed({ code: 1, stdout: "", stderr: "ModuleNotFoundError" });
          const dump = spec.args.some((argument) => argument.includes("getDesktop"));
          return Effect.succeed({ code: 0, stdout: dump ? elementDump : "", stderr: "" });
        }
        return Effect.succeed({ code: 1, stdout: "", stderr: `${spec.command} not found` });
      },
    }),
  );

const layer = (options: { readonly accessibility: boolean }) =>
  Layer.effect(DesktopDriverModule.DesktopDriver, DesktopDriverModule.make()).pipe(
    Layer.provide(fakeCommands(options)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-desktop-status-" })),
    Layer.provide(NodeServices.layer),
    Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
    Layer.provide(
      Layer.succeed(HostProcessEnvironment, {
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: "wayland-0",
      }),
    ),
  );

describe("desktop status capability model", () => {
  it.effect("stays available through AT-SPI when no screenshot or input helper exists", () =>
    Effect.gen(function* () {
      const driver = yield* DesktopDriverModule.DesktopDriver;
      const status = yield* driver.getStatus();
      expect(status.backend).toBe("linux-wayland");
      expect(status.available).toBe(true);
      expect(status.supports.accessibility).toBe(true);
      expect(status.supports.capture).toBe(false);
      expect(status.supports.pointer).toBe(false);
      expect(status.supports.keyboard).toBe(false);
      expect(status.displays).toHaveLength(1);
      expect(status.reason).toContain("screenshots");
    }).pipe(Effect.provide(layer({ accessibility: true }))),
  );

  it.effect("reports unavailable when no control path exists at all", () =>
    Effect.gen(function* () {
      const driver = yield* DesktopDriverModule.DesktopDriver;
      const status = yield* driver.getStatus();
      expect(status.available).toBe(false);
      expect(status.reason).toContain("No desktop control path");
    }).pipe(Effect.provide(layer({ accessibility: false }))),
  );

  it.effect("reads element state from the accessibility tree without capturing", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const driver = yield* DesktopDriverModule.DesktopDriver;
      const state = yield* driver.state();
      expect(state.elements).toHaveLength(1);
      expect(state.elements[0]).toMatchObject({
        role: "entry",
        name: "Search",
        x: 10,
        y: 20,
        width: 300,
        height: 40,
      });
      // Reading state must never spawn a capture helper: on GNOME Wayland the
      // portal screenshot flashes the user's screen.
      expect(
        recorded.some(([command]) => command === "grim" || command === "gnome-screenshot"),
      ).toBe(false);
    }).pipe(Effect.provide(layer({ accessibility: true }))),
  );
});
