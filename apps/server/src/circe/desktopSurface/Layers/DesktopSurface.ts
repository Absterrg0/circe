import type { DesktopUseBackend } from "@circe/contracts";
import {
  validateDesktopSurfaceAction,
  type DesktopRegion,
  type DesktopSnapshot,
  type DesktopSurfaceAction,
} from "@circe/core/desktopSurface";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { DesktopCommands } from "../../desktopUse/DesktopCommands.ts";
import { DesktopUse } from "../../desktopUse/DesktopUse.ts";
import {
  buildAccessibilityActionCommand,
  decodeAccessibilityActionResultJson,
  observeLinuxDesktop,
  type AccessibilityCommandRunner,
} from "../../desktopUse/linuxAccessibility.ts";
import { detectDisplayServer, resolveBackend } from "../../desktopUse/platforms.ts";
import {
  DesktopSurface,
  DesktopSurfaceBackendError,
  DesktopSurfaceStaleError,
  DesktopSurfaceUnavailableError,
  type DesktopSurfaceShape,
} from "../Services/DesktopSurface.ts";

const COMMAND_TIMEOUT_MS = 8_000;
const SCROLL_DELTA_PX = 400;

interface CachedTarget {
  readonly path: string;
  readonly role: string | null;
  readonly name: string;
  readonly bounds: DesktopRegion["bounds"];
}

interface CachedSnapshot {
  readonly snapshot: DesktopSnapshot;
  readonly targets: ReadonlyMap<string, CachedTarget>;
}

const supportedBackend = (backend: DesktopUseBackend): boolean =>
  backend === "linux-x11" || backend === "linux-wayland";

const sameTarget = (region: DesktopRegion, target: CachedTarget): boolean =>
  region.role === target.role &&
  region.name === target.name &&
  region.bounds.x === target.bounds.x &&
  region.bounds.y === target.bounds.y &&
  region.bounds.width === target.bounds.width &&
  region.bounds.height === target.bounds.height;

const centerOf = (bounds: DesktopRegion["bounds"]): { readonly x: number; readonly y: number } => ({
  x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height / 2,
});

/** Accessibility control is implemented on Linux; other platforms report unavailable. */
export const make = (options: { readonly backend?: DesktopUseBackend } = {}) =>
  Effect.gen(function* () {
    const desktopUse = yield* DesktopUse;
    const commands = yield* DesktopCommands;
    const displayServer = detectDisplayServer(process.env);
    const backend =
      options.backend ?? resolveBackend({ platform: process.platform, displayServer });
    const cache = yield* Ref.make<CachedSnapshot | null>(null);
    let sequence = 0;

    const runCommand: AccessibilityCommandRunner = (command, operation) =>
      commands.run(command, backend, operation, COMMAND_TIMEOUT_MS);

    const backendError = (operation: string, cause: unknown) =>
      new DesktopSurfaceBackendError({ operation, cause });

    const observe: DesktopSurfaceShape["observe"] = Effect.fn("DesktopSurface.observe")(function* (
      input = {},
    ) {
      if (!supportedBackend(backend)) {
        return yield* Effect.fail(
          new DesktopSurfaceUnavailableError({
            reason:
              "This node's desktop backend is unavailable; accessibility control is implemented for Linux for now.",
          }),
        );
      }
      const status = yield* desktopUse
        .getStatus()
        .pipe(Effect.mapError((cause) => backendError("status", cause)));
      const display = status.displays.find((candidate) => candidate.primary) ?? status.displays[0];
      const surface = yield* observeLinuxDesktop(runCommand, {
        backend,
        title: input.title ?? "Desktop",
      }).pipe(Effect.mapError((cause) => backendError("observe", cause)));

      sequence += 1;
      const captureId = `cap_${sequence}`;
      const targets = new Map<string, CachedTarget>();
      const regions: Array<DesktopRegion> = surface.elements.map((element) => {
        targets.set(element.id, {
          path: element.id,
          role: element.role,
          name: element.name,
          bounds: element.bounds,
        });
        return {
          id: element.id,
          role: element.role,
          name: element.name,
          bounds: element.bounds,
          source: "semantic",
          interactive: true,
        };
      });
      const snapshot: DesktopSnapshot = {
        capture: {
          captureId,
          displayId: display?.id ?? "primary",
          width: display?.width ?? 0,
          height: display?.height ?? 0,
          scale: display?.scale ?? 1,
          takenAtMs: yield* Clock.currentTimeMillis,
          source: "semantic",
        },
        title: surface.title,
        regions,
      };
      yield* Ref.set(cache, { snapshot, targets });
      return snapshot;
    });

    const act: DesktopSurfaceShape["act"] = Effect.fn("DesktopSurface.act")(function* (action) {
      if (!supportedBackend(backend)) {
        return yield* Effect.fail(
          new DesktopSurfaceUnavailableError({
            reason: "This node's desktop backend is unavailable.",
          }),
        );
      }

      const cached = yield* Ref.get(cache);
      if (cached === null) {
        return yield* Effect.fail(new DesktopSurfaceStaleError({ captureId: action.captureId }));
      }
      const refusal = validateDesktopSurfaceAction(cached.snapshot, action);
      // An unknown region means the snapshot did not offer it, so the surface
      // moved on: observe again. Only a malformed or non-actionable target is
      // a plain refusal.
      if (refusal === "stale-capture" || refusal === "unknown-region") {
        return yield* Effect.fail(new DesktopSurfaceStaleError({ captureId: action.captureId }));
      }
      if (refusal !== null) {
        return yield* Effect.fail(
          new DesktopSurfaceUnavailableError({ reason: `The action was refused: ${refusal}.` }),
        );
      }

      // A capture backs exactly one action: consume it, so a second action on
      // the same observation is refused until the surface is observed again.
      yield* Ref.set(cache, null);

      const pointerClick = (bounds: DesktopRegion["bounds"]) =>
        desktopUse
          .input({ action: { type: "pointer.click", ...centerOf(bounds) } })
          .pipe(Effect.mapError((cause) => backendError("click", cause)));

      if (action.kind === "scroll") {
        yield* desktopUse
          .input({
            action: {
              type: "pointer.scroll",
              ...(action.direction === "up" || action.direction === "down"
                ? { deltaY: action.direction === "down" ? SCROLL_DELTA_PX : -SCROLL_DELTA_PX }
                : { deltaX: action.direction === "right" ? SCROLL_DELTA_PX : -SCROLL_DELTA_PX }),
            },
          })
          .pipe(Effect.mapError((cause) => backendError("scroll", cause)));
        return;
      }

      const typeText = (text: string) =>
        desktopUse
          .input({ action: { type: "keyboard.type", text } })
          .pipe(Effect.mapError((cause) => backendError("type", cause)));
      const pressKey = (key: string) =>
        desktopUse
          .input({ action: { type: "keyboard.key", key } })
          .pipe(Effect.mapError((cause) => backendError("press", cause)));

      if (action.regionId === undefined) {
        if (action.kind === "type") yield* typeText(action.text);
        else if (action.kind === "press") yield* pressKey(action.key);
        return;
      }

      const target = cached.targets.get(action.regionId);
      if (target === undefined) {
        return yield* Effect.fail(new DesktopSurfaceStaleError({ captureId: action.captureId }));
      }

      // A key press on a region first focuses it, then presses.
      if (action.kind === "press") {
        yield* pointerClick(target.bounds);
        yield* pressKey(action.key);
        return;
      }

      const command = buildAccessibilityActionCommand({
        path: target.path,
        expect: { role: target.role, name: target.name },
        ...(action.kind === "type"
          ? { action: "set-text" as const, text: action.text }
          : { action: "activate" as const }),
      });
      const result = yield* runCommand(command, "desktop.surface.act").pipe(
        Effect.mapError((cause) => backendError("act", cause)),
      );
      const decoded = yield* Effect.sync(() => {
        try {
          return decodeAccessibilityActionResultJson(result.stdout);
        } catch {
          return null;
        }
      });
      if (decoded?.ok === true) return;
      if (decoded?.error === "element-changed" || decoded?.error === "element-not-found") {
        return yield* Effect.fail(new DesktopSurfaceStaleError({ captureId: action.captureId }));
      }

      // No accessibility action interface: fall back to the pointer, but only
      // after proving the target still occupies the geometry it was observed
      // with. Re-observing replaces the cache with the fresh capture.
      const fresh = yield* observe({ title: cached.snapshot.title });
      const freshRegion = fresh.regions.find((region) => region.id === action.regionId);
      if (freshRegion === undefined || !sameTarget(freshRegion, target)) {
        return yield* Effect.fail(new DesktopSurfaceStaleError({ captureId: action.captureId }));
      }
      yield* pointerClick(target.bounds);
      if (action.kind === "type") yield* typeText(action.text);
    });

    const snapshot: DesktopSurfaceShape["snapshot"] = (captureId) =>
      Ref.get(cache).pipe(
        Effect.map((cached) =>
          cached !== null && cached.snapshot.capture.captureId === captureId
            ? cached.snapshot
            : null,
        ),
      );

    return DesktopSurface.of({ observe, snapshot, act });
  });

export const layer = (options: { readonly backend?: DesktopUseBackend } = {}) =>
  Layer.effect(DesktopSurface, make(options));

/** The node's own desktop: backend resolved from the running platform. */
export const DesktopSurfaceLive = layer();
