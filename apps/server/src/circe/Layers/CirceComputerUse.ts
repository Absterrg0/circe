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

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
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
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceComputerUse } from "../Services/CirceComputerUse.ts";

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
    case "clarification":
      return { status: "needs-input", message: result.prompt };
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
    const decision = yield* CirceDecision;
    const serverEnvironment = yield* ServerEnvironment;
    const displayServer = detectDisplayServer(process.env);
    const backend =
      options.backend ?? resolveBackend({ platform: process.platform, displayServer });

    const runCommand: AccessibilityCommandRunner = (command, operation) =>
      commands.run(command, backend, operation, COMMAND_TIMEOUT_MS);

    const runAtspiAction = (request: Parameters<typeof buildAccessibilityActionCommand>[0]) =>
      runCommand(buildAccessibilityActionCommand(request), "desktop.accessibility.act").pipe(
        Effect.flatMap(({ stdout }) =>
          Effect.try({
            try: () => decodeAccessibilityActionResultJson(stdout).ok,
            catch: () => false,
          }),
        ),
        Effect.catch(() => Effect.succeed(false)),
      );

    const actuator: DesktopActuator<MissionError> = {
      activate: (elementId) => runAtspiAction({ path: elementId, action: "activate" }),
      setText: (elementId, text) => runAtspiAction({ path: elementId, action: "set-text", text }),
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
      yield* serverEnvironment.getEnvironmentId;
      const observe = () => observeLinuxDesktop(runCommand, { backend, title: "Desktop" });
      const select = (request: DecisionRequest) =>
        decision
          .decide(request)
          .pipe(Effect.map((outcome) => (outcome.status === "answered" ? outcome.answers : {})));
      return yield* runComputerUse<MissionError>({
        model: DECISION_MODEL,
        goal: input.goal,
        ...(input.typeText === undefined ? {} : { typeText: input.typeText }),
        ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
        runtime: makeDesktopUseRuntime({ observe, select, actuator }),
      }).pipe(
        Effect.map((result) => mapResult(result, input.goal)),
        Effect.catch(() =>
          Effect.succeed({
            status: "refused" as const,
            message: "I couldn't drive the desktop for that request.",
          }),
        ),
      );
    });

    return CirceComputerUse.of({ run });
  });

export const CirceComputerUseLive = Layer.effect(CirceComputerUse, make());
