import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type ServerProvider,
} from "@circe/contracts";
import type { CirceDecisionOutcome, DecisionAnswer } from "@circe/core/decision";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { CirceDecision } from "../Services/CirceDecision.ts";
import { CirceNodeTools } from "../Services/CirceNodeTools.ts";
import { CirceControllerInterpreter } from "../Services/CirceController.ts";
import { makeCirceControllerInterpreterLive } from "./CirceController.ts";

const project: OrchestrationProjectShell = {
  id: ProjectId.make("project-beacon"),
  title: "Conversations",
  workspaceRoot: "/workspace/beacon",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-12T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      shortName: "Sol",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const interpreterLayer = (answers: Record<string, DecisionAnswer>) => {
  const decisionLayer = Layer.succeed(CirceDecision, {
    decide: (): Effect.Effect<CirceDecisionOutcome> =>
      Effect.succeed({
        status: "answered" as const,
        model: "jev-test",
        answers,
      }),
  });
  return makeCirceControllerInterpreterLive(
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([codex]) }),
    decisionLayer,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({}),
        ServerSettingsModule.ServerSettingsService.layerTest({}),
        Layer.succeed(CirceNodeTools, {
          available: ["weather", "time", "task-status", "list-projects"],
          executors: {},
        }),
      ),
    ),
  );
};

const context = (
  utterance: string,
  clientTools?: ReadonlyArray<"open-website" | "browse" | "preview">,
) => ({
  utterance,
  currentProjectId: project.id,
  projects: [project],
  aliases: [],
  tasks: [],
  providers: [codex],
  supervisorModelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
  nodeDefaultModelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
  continueContext: false,
  ...(clientTools === undefined ? {} : { clientTools }),
});

describe("Circe controller interpreter outcome classification", () => {
  it.effect("resolves a lowercased place into a weather tool answer", () => {
    const layer = interpreterLayer({
      outcome: choice("weather"),
      tool_weather_location: choice("ahmedabad"),
      tool_weather_day: choice("now"),
      // Spurious work answers must not matter once the outcome is a lookup.
      destination_project: choice("Conversations"),
      needs_clarification: noul(0.95),
    });
    return Effect.gen(function* () {
      const interpreter = yield* CirceControllerInterpreter;
      const classified = yield* interpreter.classify(context("what's the weather in ahmedabad"));
      expect(classified.outcome).toEqual({
        kind: "tool-answer",
        host: "node",
        tool: "weather",
        risk: "read-only",
        args: { location: "ahmedabad", day: "now" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks a typed lookup question when no place was named", () => {
    const layer = interpreterLayer({ outcome: choice("weather") });
    return Effect.gen(function* () {
      const interpreter = yield* CirceControllerInterpreter;
      const classified = yield* interpreter.classify(context("what's the weather"));
      expect(classified.outcome.kind).toBe("clarification");
      if (classified.outcome.kind !== "clarification") return;
      expect(classified.outcome.clarification.kind).toBe("lookup");
      if (classified.outcome.clarification.kind !== "lookup") return;
      expect(classified.outcome.clarification.prompt).toBe(
        "Which place should I check for weather?",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("dispatches a website launch a client advertised", () => {
    const layer = interpreterLayer({
      outcome: choice("open-website"),
      "tool_open-website_website": choice("youtube"),
    });
    return Effect.gen(function* () {
      const interpreter = yield* CirceControllerInterpreter;
      const classified = yield* interpreter.classify(context("open youtube", ["open-website"]));
      expect(classified.outcome).toMatchObject({
        kind: "client-action",
        host: "client",
        tool: "open-website",
        args: { website: "youtube" },
        speech: "Opening youtube.",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a multi-step web goal into a browser mission client action", () => {
    const source = "open github and search for any pull requests in rivvl";
    const layer = interpreterLayer({ outcome: choice("browse") });
    return Effect.gen(function* () {
      const interpreter = yield* CirceControllerInterpreter;
      const classified = yield* interpreter.classify(context(source, ["browse"]));
      expect(classified.outcome).toMatchObject({
        kind: "client-action",
        host: "client",
        tool: "browse",
        risk: "destructive",
        args: { goal: source },
        speech: "Working in your browser.",
      });
      const propose = interpreter.propose;
      expect(propose).toBeDefined();
      if (propose === undefined) return;
      const proposal = yield* propose({
        utterance: source,
        projects: [],
        tasks: [],
        providers: [],
        clientTools: ["browse"],
        requestMetadata: { requestId: "browse-1", origin: { originInteractionId: "test" } },
      });
      expect(proposal).toMatchObject({ action: "browse", browserGoal: source });
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves a preview goal into a preview mission client action", () => {
    const source = "test the checkout flow against localhost";
    const layer = interpreterLayer({ outcome: choice("preview") });
    return Effect.gen(function* () {
      const interpreter = yield* CirceControllerInterpreter;
      const classified = yield* interpreter.classify(context(source, ["preview"]));
      expect(classified.outcome).toMatchObject({
        kind: "client-action",
        host: "client",
        tool: "preview",
        risk: "destructive",
        args: { goal: source },
        speech: "Working in the preview browser.",
      });
      const propose = interpreter.propose;
      expect(propose).toBeDefined();
      if (propose === undefined) return;
      const proposal = yield* propose({
        utterance: source,
        projects: [],
        tasks: [],
        providers: [],
        clientTools: ["preview"],
        requestMetadata: { requestId: "preview-1", origin: { originInteractionId: "test" } },
      });
      expect(proposal).toMatchObject({ action: "preview", browserGoal: source });
    }).pipe(Effect.provide(layer));
  });

  it.effect("routes a scoped conversation into a durable provider thread", () => {
    const layer = interpreterLayer({ outcome: choice("conversation") });
    return Effect.gen(function* () {
      const interpreter = yield* CirceControllerInterpreter;
      const classified = yield* interpreter.classify(
        context("all right, search Tanmay Bhat for me"),
      );
      expect(classified.outcome.kind).toBe("conversation");
      expect(classified.interpretation.status).toBe("command");
      if (classified.interpretation.status !== "command") return;
      expect(classified.interpretation.command.type).toBe("start");
      if (classified.interpretation.command.type !== "start") return;
      expect(classified.interpretation.command.flow).toBe("conversation");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a website launch when the turn advertises no client tools", () => {
    const layer = interpreterLayer({
      outcome: choice("open-website"),
      "tool_open-website_website": choice("youtube"),
    });
    return Effect.gen(function* () {
      const interpreter = yield* CirceControllerInterpreter;
      const classified = yield* interpreter.classify(context("open youtube", []));
      expect(classified.outcome.kind).toBe("refused");
    }).pipe(Effect.provide(layer));
  });
});
