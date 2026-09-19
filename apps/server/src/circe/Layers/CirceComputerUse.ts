import type {
  CirceComputerUseInput,
  CirceComputerUseResult,
  DesktopUseBackend,
  DesktopUseError,
  DesktopUsePolicyError,
} from "@circe/contracts";
import type { ComputerUseRunResult, ComputerStepRefusal } from "@circe/core/computerUse";
import { runComputerUse } from "@circe/core/computerUse";
import type { DecisionRequest } from "@circe/core/decision";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { DesktopCommands } from "../desktopUse/DesktopCommands.ts";
import { DesktopUse } from "../desktopUse/DesktopUse.ts";
import {
  buildAccessibilityActionCommand,
  decodeAccessibilityActionResultJson,
  observeLinuxDesktop,
  type AccessibilityCommandError,
  type AccessibilityCommandRunner,
} from "../desktopUse/linuxAccessibility.ts";
import {
  makeDesktopUseRuntime,
  type DesktopActuator,
  type DesktopScrollDirection,
} from "../desktopUse/desktopUseRuntime.ts";
import { detectDisplayServer, resolveBackend } from "../desktopUse/platforms.ts";
import {
  DesktopElementChangedError,
  SurfaceDecisionUnavailableError,
} from "../computerUse/SurfaceDecisionError.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";
import { CirceMissionCancellation } from "../Services/CirceMissionCancellation.ts";

const DECISION_MODEL = "jev-latest";
const COMMAND_TIMEOUT_MS = 8_000;
const SCROLL_DELTA_PX = 400;
const WAIT_MS = 300;

type MissionError = AccessibilityCommandError | DesktopUsePolicyError | DesktopUseError;

const confirmationMessage = (goal: string): string =>
  `I'll control this computer in this session to ${goal}. Confirm to start.`;

const refusalMessage = (reason: ComputerStepRefusal): string => {
  switch (reason) {
    case "confidence-too-low":
      return "I couldn't tell what to do next on this screen.";
    case "unknown-element":
      return "The screen changed before I could act on it.";
    case "missing-parameter":
      return "That step was missing a target or value.";
  }
};

const mapResult = (result: ComputerUseRunResult, goal: string): CirceComputerUseResult => {
  switch (result.status) {
    case "done":
      return { status: "done", message: `Done: ${result.summary}`, steps: result.steps };
    case "budget-exhausted":
      return {
        status: "budget",
        message: `I took ${result.steps} steps but couldn't finish ${goal}.`,
        steps: result.steps,
      };
    case "unverified":
      return {
        status: "refused",
        message: `The model reported ${goal} done, but no action was taken, so I couldn't confirm it.`,
      };
    case "cancelled":
      return { status: "cancelled", message: "Stopped.", steps: result.steps };
    case "refused":
      return { status: "refused", message: refusalMessage(result.reason) };
  }
};

const scrollDeltas = (
  direction: DesktopScrollDirection,
): { readonly deltaX?: number; readonly deltaY?: number } =>
  direction === "up" || direction === "down"
    ? { deltaY: direction === "down" ? SCROLL_DELTA_PX : -SCROLL_DELTA_PX }
    : { deltaX: direction === "right" ? SCROLL_DELTA_PX : -SCROLL_DELTA_PX };

const supportedBackend = (backend: DesktopUseBackend): boolean =>
  backend === "linux-x11" || backend === "linux-wayland";

export const make = (options: { readonly backend?: DesktopUseBackend } = {}) =>
  Effect.gen(function* () {
    const desktopUse = yield* DesktopUse;
    const commands = yield* DesktopCommands;
    // The decision tier is optional: a node without it has no step model, so a
    // mission reports `unavailable` instead of refusing to build the layer.
    const decisionOpt = yield* Effect.serviceOption(CirceDecision);
    const decision = Option.getOrElse(decisionOpt, () => ({
      decide: (_request: DecisionRequest) =>
        Effect.succeed({ status: "decline", reason: "decision-disabled" } as const),
    }));
    const cancellation = yield* CirceMissionCancellation;
    const displayServer = detectDisplayServer(process.env);
    const backend =
      options.backend ?? resolveBackend({ platform: process.platform, displayServer });

    const runCommand: AccessibilityCommandRunner = (command, operation) =>
      commands.run(command, backend, operation, COMMAND_TIMEOUT_MS);
    // A transport failure propagates. A decoded result distinguishes "no
    // action interface", which allows the grounded coordinate fallback, from
    // an identity change, which must refuse rather than click stale geometry.
    const runAtspiAction = (
      request: Parameters<typeof buildAccessibilityActionCommand>[0],
    ): Effect.Effect<"ok" | "no-action" | "refuse", AccessibilityCommandError> =>
      runCommand(buildAccessibilityActionCommand(request), "desktop.accessibility.act").pipe(
        Effect.map(({ stdout }): "ok" | "no-action" | "refuse" => {
          try {
            const result = decodeAccessibilityActionResultJson(stdout);
            if (result.ok) return "ok";
            if (result.error === "element-changed" || result.error === "element-not-found") {
              return "refuse";
            }
            return "no-action";
          } catch {
            // A helper that emitted garbage is treated as "no action
            // interface", which allows the grounded coordinate fallback.
            return "no-action";
          }
        }),
      );

    const expectation = (element: { readonly role: string | null; readonly name: string }) => ({
      role: element.role,
      name: element.name,
    });

    const runElementAction = (
      element: { readonly id: string; readonly role: string | null; readonly name: string },
      request:
        | { readonly action: "activate" }
        | { readonly action: "set-text"; readonly text: string },
    ): Effect.Effect<boolean, MissionError | DesktopElementChangedError> =>
      runAtspiAction({
        path: element.id,
        expect: expectation(element),
        ...request,
      }).pipe(
        Effect.flatMap((outcome) =>
          outcome === "refuse"
            ? Effect.fail(new DesktopElementChangedError({ elementId: element.id }))
            : Effect.succeed(outcome === "ok"),
        ),
      );

    const actuator: DesktopActuator<MissionError | DesktopElementChangedError> = {
      activate: (element) => runElementAction(element, { action: "activate" }),
      setText: (element, text) => runElementAction(element, { action: "set-text", text }),
      clickAt: (element) =>
        desktopUse
          .input({
            action: {
              type: "pointer.click",
              x: element.bounds.x + element.bounds.width / 2,
              y: element.bounds.y + element.bounds.height / 2,
            },
          })
          .pipe(Effect.asVoid),
      typeText: (text) =>
        desktopUse.input({ action: { type: "keyboard.type", text } }).pipe(Effect.asVoid),
      pressKey: (key) =>
        desktopUse.input({ action: { type: "keyboard.key", key } }).pipe(Effect.asVoid),
      scroll: (direction) =>
        desktopUse
          .input({ action: { type: "pointer.scroll", ...scrollDeltas(direction) } })
          .pipe(Effect.asVoid),
      wait: () => Effect.sleep(WAIT_MS),
    };

    const run = Effect.fn("CirceComputerUse.run")(function* (input: CirceComputerUseInput) {
      if (input.confirmed !== true) {
        return { status: "needs-input", message: confirmationMessage(input.goal) } as const;
      }
      if (!supportedBackend(backend)) {
        return {
          status: "unavailable",
          message: "Desktop control is available on Linux for now.",
        } as const;
      }
      const requestId = input.requestMetadata?.requestId;
      if (requestId !== undefined) yield* cancellation.register(requestId);
      const observe = () => observeLinuxDesktop(runCommand, { backend, title: "Desktop" });
      const select = (request: DecisionRequest) =>
        decision
          .decide(request)
          .pipe(
            Effect.flatMap((outcome) =>
              outcome.status === "answered"
                ? Effect.succeed(outcome.answers)
                : Effect.fail(new SurfaceDecisionUnavailableError({ reason: outcome.reason })),
            ),
          );
      type RunError = MissionError | SurfaceDecisionUnavailableError | DesktopElementChangedError;
      return yield* runComputerUse<RunError>({
        model: DECISION_MODEL,
        goal: input.goal,
        ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
        ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
        ...(requestId === undefined
          ? {}
          : { shouldStop: () => cancellation.isCancelled(requestId) }),
        runtime: makeDesktopUseRuntime<RunError>({
          observe,
          select,
          actuator,
        }),
      }).pipe(
        Effect.map((result) => mapResult(result, input.goal)),
        Effect.catchTag("SurfaceDecisionUnavailableError", (error) =>
          Effect.succeed({ status: "unavailable" as const, message: error.message }),
        ),
        Effect.catchTag("DesktopElementChangedError", (error) =>
          Effect.succeed({ status: "refused" as const, message: error.message }),
        ),
        Effect.catch(() =>
          Effect.succeed({
            status: "refused" as const,
            message: "I couldn't drive the desktop for that request.",
          }),
        ),
        Effect.ensuring(requestId === undefined ? Effect.void : cancellation.clear(requestId)),
      );
    });

    return CirceComputerUse.of({ run });
  });

export const CirceComputerUseLive = Layer.effect(CirceComputerUse, make());
