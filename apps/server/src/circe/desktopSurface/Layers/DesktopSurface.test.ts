import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { DesktopCommands } from "../../desktopUse/DesktopCommands.ts";
import { DesktopUse } from "../../desktopUse/DesktopUse.ts";
import { DesktopPerceptionNone } from "../Services/DesktopPerception.ts";
import {
  DesktopSurface,
  type DesktopSurfaceError,
  type DesktopSurfaceShape,
} from "../Services/DesktopSurface.ts";
import { make } from "./DesktopSurface.ts";

const dump = JSON.stringify({
  elements: [
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

const status = {
  available: true,
  platform: "linux" as const,
  backend: "linux-x11" as const,
  displays: [{ id: "d1", x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true }],
  supports: { capture: true, pointer: true, keyboard: true, windows: true },
};

const testLayer = (operations: Array<string>) =>
  Layer.effect(DesktopSurface, make({ backend: "linux-x11" })).pipe(
    Layer.provide(
      Layer.mock(DesktopUse)({
        getStatus: () => Effect.succeed(status),
        input: (request) =>
          Effect.sync(() => {
            operations.push(request.action.type);
            return {};
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(DesktopCommands)({
        run: (_command, _backend, operation) =>
          Effect.succeed({
            stdout: operation === "desktop.accessibility" ? dump : JSON.stringify({ ok: true }),
            stderr: "",
            code: 0,
          }),
      }),
    ),
    Layer.provide(DesktopPerceptionNone),
  );

const runWithSurface = <A>(
  layer: Layer.Layer<DesktopSurface>,
  program: (surface: DesktopSurfaceShape) => Effect.Effect<A, DesktopSurfaceError>,
): A =>
  Effect.runSync(
    Effect.gen(function* () {
      const surface = yield* DesktopSurface;
      return yield* program(surface);
    }).pipe(Effect.orDie, Effect.provide(layer)),
  );

const tagOf = <A, E extends { readonly _tag: string }>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "ok" }));

describe("desktop surface", () => {
  it("observes a snapshot with an addressable region and a capture id", () => {
    const snapshot = runWithSurface(testLayer([]), (surface) => surface.observe());
    expect(snapshot.capture.captureId).toBe("cap_1");
    expect(snapshot.capture.source).toBe("semantic");
    expect(snapshot.regions.map((region) => region.id)).toEqual(["app:0/0/3"]);
  });

  it("executes a capture-bound click and consumes the capture", () => {
    const result = runWithSurface(testLayer([]), (surface) =>
      Effect.gen(function* () {
        const snapshot = yield* surface.observe();
        const first = yield* tagOf(
          surface.act({
            kind: "click",
            captureId: snapshot.capture.captureId,
            regionId: "app:0/0/3",
          }),
        );
        // A second action on the same observation is refused until re-observed.
        const second = yield* tagOf(
          surface.act({
            kind: "click",
            captureId: snapshot.capture.captureId,
            regionId: "app:0/0/3",
          }),
        );
        return { first, second };
      }),
    );
    expect(result).toEqual({ first: "ok", second: "DesktopSurfaceStaleError" });
  });

  it("refuses an action bound to a capture that never existed", () => {
    const result = runWithSurface(testLayer([]), (surface) =>
      Effect.gen(function* () {
        yield* surface.observe();
        return yield* tagOf(
          surface.act({ kind: "click", captureId: "cap-nope", regionId: "app:0/0/3" }),
        );
      }),
    );
    expect(result).toBe("DesktopSurfaceStaleError");
  });

  it("refuses a click on a region the snapshot did not offer", () => {
    const result = runWithSurface(testLayer([]), (surface) =>
      Effect.gen(function* () {
        const snapshot = yield* surface.observe();
        return yield* tagOf(
          surface.act({
            kind: "click",
            captureId: snapshot.capture.captureId,
            regionId: "not-offered",
          }),
        );
      }),
    );
    expect(result).toBe("DesktopSurfaceStaleError");
  });

  it("types into the focused element when no region is named", () => {
    const operations: Array<string> = [];
    const result = runWithSurface(testLayer(operations), (surface) =>
      Effect.gen(function* () {
        const snapshot = yield* surface.observe();
        return yield* tagOf(
          surface.act({ kind: "type", captureId: snapshot.capture.captureId, text: "hello" }),
        );
      }),
    );
    expect(result).toBe("ok");
    expect(operations).toEqual(["keyboard.type"]);
  });
});
