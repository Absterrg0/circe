import {
  buildComputerStepRequest,
  composeComputerStep,
  type ComputerAction,
  type ComputerSurface,
} from "@circe/core/computerUse";
import type { DesktopSnapshot, DesktopSurfaceAction } from "@circe/core/desktopSurface";
import * as Effect from "effect/Effect";

import * as DesktopUse from "../../../circe/desktopUse/DesktopUse.ts";
import { DesktopSurface } from "../../../circe/desktopSurface/Services/DesktopSurface.ts";
import { CirceDecision } from "../../../circe/Services/CirceDecision.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DesktopUseToolkit, type DesktopDecideResult } from "./tools.ts";

const DECISION_MODEL = "jev-latest";

const toComputerSurface = (snapshot: DesktopSnapshot): ComputerSurface => ({
  kind: "desktop",
  title: snapshot.title,
  elements: snapshot.regions.map((region) => ({
    id: region.id,
    role: region.role,
    name: region.name,
    bounds: region.bounds,
  })),
});

const toSurfaceAction = (captureId: string, action: ComputerAction): DesktopDecideResult => {
  switch (action.kind) {
    case "click":
      return { status: "action", action: { kind: "click", captureId, regionId: action.elementId } };
    case "type":
      return {
        status: "action",
        action: {
          kind: "type",
          captureId,
          ...(action.elementId === undefined ? {} : { regionId: action.elementId }),
          text: action.text,
        },
      };
    case "press":
      return {
        status: "action",
        action: {
          kind: "press",
          captureId,
          ...(action.elementId === undefined ? {} : { regionId: action.elementId }),
          key: action.key,
        },
      };
    case "scroll":
      return {
        status: "action",
        action: { kind: "scroll", captureId, direction: action.direction },
      };
    case "wait":
      return { status: "wait" };
  }
};

const make = Effect.gen(function* () {
  const desktopUse = yield* DesktopUse.DesktopUse;
  const surface = yield* DesktopSurface;
  const decision = yield* CirceDecision;
  const requireCapability = () => McpInvocationContext.requireMcpCapability("desktop-use");

  return DesktopUseToolkit.of({
    desktop_status: () => requireCapability().pipe(Effect.andThen(desktopUse.getStatus())),
    desktop_move: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: { type: "pointer.move", x: input.x, y: input.y },
          }),
        ),
      ),
    desktop_click: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: {
              type: "pointer.click",
              ...(input.x === undefined || input.y === undefined ? {} : { x: input.x, y: input.y }),
              ...(input.button === undefined ? {} : { button: input.button }),
              ...(input.count === undefined ? {} : { count: input.count }),
            },
          }),
        ),
      ),
    desktop_drag: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: {
              type: "pointer.drag",
              from: { x: input.fromX, y: input.fromY },
              to: { x: input.toX, y: input.toY },
              ...(input.button === undefined ? {} : { button: input.button }),
              ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
            },
          }),
        ),
      ),
    desktop_scroll: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: {
              type: "pointer.scroll",
              ...(input.x === undefined ? {} : { x: input.x }),
              ...(input.y === undefined ? {} : { y: input.y }),
              ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }),
              ...(input.deltaY === undefined ? {} : { deltaY: input.deltaY }),
            },
          }),
        ),
      ),
    desktop_type: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: { type: "keyboard.type", text: input.text },
          }),
        ),
      ),
    desktop_key: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({
            displayId: input.displayId,
            action: {
              type: "keyboard.key",
              key: input.key,
              ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
            },
          }),
        ),
      ),
    desktop_windows: () =>
      requireCapability().pipe(
        Effect.andThen(desktopUse.listWindows().pipe(Effect.map((windows) => ({ windows })))),
      ),
    desktop_focus_window: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          desktopUse.input({ action: { type: "window.focus", windowId: input.windowId } }),
        ),
      ),
    // The provider's harness owns the loop: observe, decide, act. The node
    // holds one capture per observe and refuses an action when the desktop
    // moved on, so a step can never land on a target the provider did not see.
    desktop_observe: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          surface
            .observe(
              input.includeVisual === undefined ? {} : { includeVisual: input.includeVisual },
            )
            .pipe(
              Effect.map((snapshot) => ({
                captureId: snapshot.capture.captureId,
                displayId: snapshot.capture.displayId,
                title: snapshot.title,
                width: snapshot.capture.width,
                height: snapshot.capture.height,
                regions: snapshot.regions,
              })),
            ),
        ),
      ),
    desktop_decide: (input) =>
      requireCapability().pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const snapshot = yield* surface.snapshot(input.captureId);
            if (snapshot === null) {
              return {
                status: "unavailable" as const,
                message: "That capture is no longer current; observe again.",
              };
            }
            const computerSurface = toComputerSurface(snapshot);
            const request = buildComputerStepRequest({
              model: DECISION_MODEL,
              goal: input.goal,
              surface: computerSurface,
              history: [],
            });
            const outcome = yield* decision.decide(request);
            if (outcome.status !== "answered") {
              return {
                status: "unavailable" as const,
                message: `TypeSafe declined the decision: ${outcome.reason}`,
              };
            }
            const step = composeComputerStep({
              goal: input.goal,
              surface: computerSurface,
              answers: outcome.answers,
            });
            if (step.kind === "done") return { status: "done" as const, summary: step.summary };
            if (step.kind === "refused") {
              return { status: "refused" as const, reason: step.reason };
            }
            return toSurfaceAction(input.captureId, step.action);
          }),
        ),
      ),
    desktop_act: (input) =>
      requireCapability().pipe(
        Effect.andThen(surface.act(input.action).pipe(Effect.as({ applied: true }))),
      ),
  });
});

export const DesktopUseToolkitHandlersLive = DesktopUseToolkit.toLayer(make);
