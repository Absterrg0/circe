import type {
  ComputerPlanInput,
  ComputerPlanStep,
  ComputerRecoveryInput,
  ComputerRecoveryStep,
} from "@circe/core/computerUse";
import { COMPUTER_PLAN_MAX_STEPS, COMPUTER_RECOVERY_MAX_STEPS } from "@circe/core/computerUse";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  CirceDesktopPlanUnavailable,
  CirceRecoveryPlanner,
} from "../Services/CirceRecoveryPlanner.ts";

const MAX_ELEMENTS = 60;
const RECOVERY_TIMEOUT = "20 seconds";
/** A desktop plan can take a whole goal; the executor has nothing to do until it arrives. */
const DESKTOP_PLAN_TIMEOUT = "45 seconds";

const RecoveryStep = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("click"),
    elementId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
  }),
  Schema.Struct({
    kind: Schema.Literal("type"),
    elementId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  }),
  Schema.Struct({
    kind: Schema.Literal("press"),
    elementId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
    key: Schema.Literals([
      "enter",
      "tab",
      "escape",
      "arrowup",
      "arrowdown",
      "arrowleft",
      "arrowright",
      "backspace",
      "pageup",
      "pagedown",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    direction: Schema.Literals(["up", "down", "left", "right"]),
  }),
  Schema.Struct({ kind: Schema.Literal("wait") }),
]);
export const CirceRecoveryPlan = Schema.Struct({
  steps: Schema.Array(RecoveryStep).check(Schema.isMaxLength(COMPUTER_RECOVERY_MAX_STEPS)),
});
export type CirceRecoveryPlan = typeof CirceRecoveryPlan.Type;

/** Bounded, id-only surface so the planner can only name what was observed. */
export const buildRecoveryPrompt = (input: ComputerRecoveryInput): string => {
  const surface = {
    kind: input.surface.kind,
    title: input.surface.title.slice(0, 240),
    ...(input.surface.url === undefined ? {} : { url: input.surface.url.slice(0, 2_048) }),
    elements: input.surface.elements.slice(0, MAX_ELEMENTS).map((element) => ({
      id: element.id,
      role: element.role,
      name: element.name.slice(0, 200),
      ...(element.app === undefined ? {} : { app: element.app.slice(0, 80) }),
    })),
  };
  return [
    "A grounded step loop stalled while trying to accomplish a goal.",
    `Goal: ${input.goal.slice(0, 1_000)}`,
    `Stall: ${input.reason}`,
    `Attempted steps: ${input.history.slice(-12).join("; ") || "none"}`,
    `Observed surface: ${JSON.stringify(surface)}`,
    `Propose at most ${COMPUTER_RECOVERY_MAX_STEPS} recovery steps that move the goal forward.`,
    "Every elementId must be one of the observed element ids. Use wait only when the surface is still settling.",
    "Do not repeat attempted steps. If no grounded recovery exists, return an empty steps list.",
  ].join("\n");
};

const PlanStep = Schema.Struct({
  intent: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  action: Schema.Literals(["click", "type", "press", "scroll", "wait"]),
  targetRole: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(80)))),
  targetName: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  key: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
  direction: Schema.optional(Schema.String.check(Schema.isMaxLength(20))),
  precondition: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  postcondition: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export const CirceGoalPlan = Schema.Struct({
  steps: Schema.Array(PlanStep).check(Schema.isMaxLength(COMPUTER_PLAN_MAX_STEPS)),
});
export type CirceGoalPlan = typeof CirceGoalPlan.Type;

/** Semantic, role/name-only surface: no ids, so a plan cannot replay handles. */
export const buildGoalPlanPrompt = (input: ComputerPlanInput): string => {
  const surface = {
    kind: input.surface.kind,
    title: input.surface.title.slice(0, 240),
    ...(input.surface.url === undefined ? {} : { url: input.surface.url.slice(0, 2_048) }),
    elements: input.surface.elements.slice(0, MAX_ELEMENTS).map((element) => ({
      role: element.role,
      name: element.name.slice(0, 200),
      ...(element.value === undefined || element.value.length === 0
        ? {}
        : { value: element.value.slice(0, 120) }),
      ...(element.state === undefined ? {} : { state: element.state.slice(0, 80) }),
      ...(element.app === undefined ? {} : { app: element.app.slice(0, 80) }),
    })),
  };
  return [
    "Write a short plan of semantic steps for a grounded computer-use loop.",
    `Goal: ${input.goal.slice(0, 1_000)}`,
    `Completion kind: ${input.expectation.kind}`,
    `Why a plan is needed now: ${input.reason}`,
    `Already attempted: ${input.history.slice(-12).join("; ") || "none"}`,
    `Observed surface: ${JSON.stringify(surface)}`,
    `At most ${COMPUTER_PLAN_MAX_STEPS} steps. Each step names one visible control by role and name; never include an id.`,
    "Use click, type (with exact text), press (with a key), scroll, or wait. Keep the plan short: a step that needs a fresh screen (a dialog, navigation) ends the plan.",
    "Give each step a precondition and a postcondition in words so the host can tell whether it landed.",
    "If the goal is already satisfied by the surface, return an empty steps list.",
  ].join("\n");
};

const DesktopTarget = Schema.Struct({
  role: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
const DesktopExpectation = Schema.Struct({
  shows: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  in: Schema.optional(DesktopTarget),
});
/**
 * The shape circe-core's desktop planner asks for, so the provider's
 * structured output has a schema to follow. circe-core validates the answer
 * again; this schema only has to be no stricter than it.
 */
export const CirceDesktopPlan = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      verb: Schema.Literals(["launch", "click", "fill", "select", "press", "scroll", "inspect"]),
      intent: Schema.String.check(Schema.isMaxLength(200)),
      app: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
      newWindow: Schema.optional(Schema.Boolean),
      target: Schema.optional(DesktopTarget),
      text: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
      replace: Schema.optional(Schema.Boolean),
      option: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      key: Schema.optional(Schema.String.check(Schema.isMaxLength(20))),
      direction: Schema.optional(Schema.Literals(["up", "down", "left", "right"])),
      requires: Schema.optional(DesktopTarget),
      expect: Schema.optional(DesktopExpectation),
    }),
  ).check(Schema.isMaxLength(8)),
  done: Schema.optional(DesktopExpectation),
  clarify: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  unsupported: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
});

export const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettings = yield* ServerSettingsService;

  const plan = Effect.fn("CirceRecoveryPlanner.plan")(function* (
    input: ComputerRecoveryInput,
  ): Effect.fn.Return<ReadonlyArray<ComputerRecoveryStep>> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (settings === null) return [];
    const selection = settings.circeSupervisorModelSelection ?? settings.circeDefaultModelSelection;
    if (selection === undefined) return [];
    const generation = yield* providerRegistry
      .getTextGenerationForInstance(selection.instanceId)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (generation === undefined) return [];
    const generated = yield* Effect.scoped(
      fileSystem.makeTempDirectoryScoped({ prefix: "circe-recovery-" }).pipe(
        Effect.flatMap((cwd) =>
          generation.generateStructured({
            cwd,
            prompt: buildRecoveryPrompt(input),
            outputSchema: CirceRecoveryPlan,
            modelSelection: selection,
          }),
        ),
      ),
    ).pipe(
      Effect.timeoutOption(RECOVERY_TIMEOUT),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(generated)) {
      yield* Effect.logWarning("Circe recovery planning produced no plan");
      return [];
    }
    return generated.value.steps;
  });

  const planGoal = Effect.fn("CirceRecoveryPlanner.planGoal")(function* (
    input: ComputerPlanInput,
  ): Effect.fn.Return<ReadonlyArray<ComputerPlanStep>> {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (settings === null) return [];
    const selection = settings.circeSupervisorModelSelection ?? settings.circeDefaultModelSelection;
    if (selection === undefined) return [];
    const generation = yield* providerRegistry
      .getTextGenerationForInstance(selection.instanceId)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (generation === undefined) return [];
    const generated = yield* Effect.scoped(
      fileSystem.makeTempDirectoryScoped({ prefix: "circe-plan-" }).pipe(
        Effect.flatMap((cwd) =>
          generation.generateStructured({
            cwd,
            prompt: buildGoalPlanPrompt(input),
            outputSchema: CirceGoalPlan,
            modelSelection: selection,
          }),
        ),
      ),
    ).pipe(
      Effect.timeoutOption(RECOVERY_TIMEOUT),
      Effect.catchCause(() => Effect.succeed(Option.none())),
    );
    if (Option.isNone(generated)) {
      yield* Effect.logWarning("Circe goal planning produced no plan");
      return [];
    }
    return generated.value.steps;
  });

  const planDesktop = Effect.fn("CirceRecoveryPlanner.planDesktop")(function* (prompt: string) {
    const unavailable = (reason: string) => new CirceDesktopPlanUnavailable({ reason });
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => unavailable("the node's settings could not be read")),
    );
    const selection = settings.circeSupervisorModelSelection ?? settings.circeDefaultModelSelection;
    if (selection === undefined || selection === null)
      return yield* unavailable("no planning model is configured");
    const generation = yield* providerRegistry
      .getTextGenerationForInstance(selection.instanceId)
      .pipe(
        Effect.mapError(() => unavailable(`the planning model ${selection.model} is unavailable`)),
      );
    if (generation === undefined)
      return yield* unavailable(`the planning model ${selection.model} is unavailable`);
    const generated = yield* Effect.scoped(
      fileSystem.makeTempDirectoryScoped({ prefix: "circe-desktop-plan-" }).pipe(
        Effect.flatMap((cwd) =>
          generation.generateStructured({
            cwd,
            prompt,
            outputSchema: CirceDesktopPlan,
            modelSelection: selection,
          }),
        ),
      ),
    ).pipe(
      Effect.timeoutOption(DESKTOP_PLAN_TIMEOUT),
      Effect.tapCause((cause) => Effect.logWarning("Circe desktop planning failed", { cause })),
      Effect.catchTag("TextGenerationError", (error) =>
        Effect.fail(unavailable(desktopPlanFailureReason(selection.model, error.detail))),
      ),
      Effect.catchCause(() =>
        Effect.fail(unavailable(desktopPlanFailureReason(selection.model, undefined))),
      ),
    );
    if (Option.isNone(generated))
      return yield* unavailable(
        `the planning model ${selection.model} did not answer within ${DESKTOP_PLAN_TIMEOUT}`,
      );
    return generated.value as unknown;
  });

  return CirceRecoveryPlanner.of({ plan, planGoal, planDesktop });
});

/**
 * Why the planning model failed, in words the user can act on. Provider CLIs
 * echo the whole prompt before the cause, and put the actionable part — a
 * usage limit and when it resets, a missing sign-in — on the last `ERROR:`
 * line, so only that line is kept.
 */
export function desktopPlanFailureReason(model: string, detail: string | undefined): string {
  const errorLine = detail
    ?.split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("ERROR:"))
    ?.slice("ERROR:".length)
    .trim();
  return errorLine
    ? `the planning model ${model} failed: ${errorLine}`
    : `the planning model ${model} failed`;
}

export const CirceRecoveryPlannerLive = Layer.effect(CirceRecoveryPlanner, make);
