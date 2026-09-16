import { describe, expect, it } from "@effect/vitest";
import {
  interpretCirceCommand,
  prepareCirceSemanticTurn,
  type CirceCommandContext,
} from "@circe/core/command";
import type { CirceDecisionOutcome, DecisionAnswer, DecisionRequest } from "@circe/core/decision";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  decisionCatalogFromContext,
  decisionStateFromContext,
  runCirceDecisionTier,
} from "./decisionTier.ts";

const rivvl: OrchestrationProjectShell = {
  id: ProjectId.make("project-rivvl"),
  title: "Rivvl",
  workspaceRoot: "/workspace/rivvl",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
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
  checkedAt: "2026-08-30T00:00:00.000Z",
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

function context(utterance: string): CirceCommandContext {
  return {
    utterance,
    currentProjectId: rivvl.id,
    projects: [rivvl],
    aliases: [],
    tasks: [
      {
        threadId: ThreadId.make("thread-auth"),
        title: "Authentication",
        objective: "Fix token refresh",
        state: "running",
        voiceAliases: ["auth"],
      },
    ],
    providers: [codex],
    supervisorModelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
    nodeDefaultModelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
    continueContext: false,
  };
}

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const actAnswers = (
  overrides: Record<string, DecisionAnswer> = {},
): Record<string, DecisionAnswer> => ({
  action: choice("start"),
  destination_project: choice("Rivvl"),
  destination_negated: noul(0.05),
  task: choice("none"),
  provider: choice("none"),
  model_specified: noul(0.05),
  model: choice("none"),
  effort_specified: noul(0.05),
  effort: choice("none"),
  is_compound: noul(0.05),
  response_strategy: choice("act"),
  tool: choice("none"),
  contains_approval_verdict: noul(0.02),
  approval_verdict: choice("none"),
  needs_clarification: noul(0.05),
  ...overrides,
});

const answered = (answers: Record<string, DecisionAnswer>): CirceDecisionOutcome => ({
  status: "answered",
  model: "jev-test",
  answers,
});

const decideWith =
  (
    handler: (request: DecisionRequest) => CirceDecisionOutcome,
  ): ((request: DecisionRequest) => Effect.Effect<CirceDecisionOutcome>) =>
  (request) =>
    Effect.succeed(handler(request));

const runTier = (
  input: CirceCommandContext,
  decide: (request: DecisionRequest) => Effect.Effect<CirceDecisionOutcome>,
) =>
  runCirceDecisionTier({
    source: input.utterance,
    state: decisionStateFromContext(input, input.utterance),
    catalog: decisionCatalogFromContext(input),
    decide,
  });

describe("decision tier seam", () => {
  it.effect("produces the same start command a bounded grammar used to propose", () =>
    Effect.gen(function* () {
      const input = context("check auth in Rivvl");
      const tier = yield* runTier(
        input,
        decideWith(() => answered(actAnswers())),
      );
      expect(tier.status).toBe("proposal");
      if (tier.status !== "proposal") return;
      const prepared = prepareCirceSemanticTurn(input);
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") return;
      const interpretation = interpretCirceCommand(input, prepared, tier.proposal);
      expect(interpretation.status).toBe("command");
      if (interpretation.status !== "command") return;
      expect(interpretation.command.type).toBe("start");
      if (interpretation.command.type !== "start") return;
      expect(interpretation.command.projectId).toBe(rivvl.id);
      expect(interpretation.command.objective).toContain("check auth");
    }),
  );

  it.effect("becomes a Clarify, never a dispatch, when the action confidence is low", () =>
    Effect.gen(function* () {
      const input = context("check auth in Rivvl");
      const tier = yield* runTier(
        input,
        decideWith(() => answered(actAnswers({ action: choice("start", 0.3) }))),
      );
      expect(tier.status).toBe("needs-input");
    }),
  );

  it.effect("declines without dispatching when the decision backend is unavailable", () =>
    Effect.gen(function* () {
      const input = context("check auth in Rivvl");
      const tier = yield* runTier(input, () =>
        Effect.succeed({ status: "decline", reason: "decision-timeout" }),
      );
      expect(tier).toEqual({ status: "decline", reason: "decision-timeout" });
    }),
  );

  it.effect("runs a second request per segment and composes an ordered sequence", () =>
    Effect.gen(function* () {
      const input = context("stop auth, then create a deployment task");
      const tier = yield* runTier(
        input,
        decideWith((request) => {
          const utterance =
            typeof request.state === "object" && request.state !== null
              ? (request.state as { utterance?: unknown }).utterance
              : undefined;
          if (typeof utterance === "string" && utterance.includes(",")) {
            const answers = actAnswers();
            answers.boundary_0 = noul(0.95);
            answers.boundary_1 = noul(0.95);
            return answered(answers);
          }
          if (utterance === "stop auth") {
            return answered(
              actAnswers({
                action: choice("stop", 0.92),
                task: choice("Authentication"),
                destination_project: choice("none"),
              }),
            );
          }
          return answered(actAnswers({ destination_project: choice("none") }));
        }),
      );
      expect(tier.status).toBe("proposal");
      if (tier.status !== "proposal") return;
      expect(tier.proposal.action).toBe("sequence");
      expect((tier.proposal.steps ?? []).length).toBeGreaterThanOrEqual(2);
    }),
  );
});
