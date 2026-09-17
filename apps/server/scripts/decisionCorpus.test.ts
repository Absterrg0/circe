import { decodeCirceSemanticProposal } from "@circe/core/command";
import type { CirceSemanticProposal } from "@circe/core/semanticEvidence";
import type { DecisionAnswer, DecisionAnswers } from "@circe/core/decision";
import { composeDecision } from "@circe/core/decisionCompose";
import { buildDecisionRequest } from "@circe/core/decisionRequest";
import { describe, expect, it } from "vite-plus/test";

import { decisionCatalogFromContext, decisionStateFromContext } from "../src/circe/decisionTier.ts";
import { circeSemanticDevCorpus } from "./circeSemanticDevCorpus.ts";
import { buildEvalContext, scoreProposal } from "./circeSemanticEvalEngine.ts";

/**
 * Offline derivation corpus. This measures the deterministic half of the
 * decision tier: given the answer a correct classifier would give, does the
 * host reproduce the expected command, target, and instruction, and never
 * dispatch an excluded project? The model's own accuracy needs the live
 * TypeSafe key and is measured separately.
 */

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const findProjectKey = (
  projects: ReturnType<typeof buildDecisionRequest>["table"]["projects"],
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const folded = value.trim().toLowerCase();
  return projects.find(
    (project) =>
      project.title.toLowerCase() === folded ||
      project.names.some((name) => name.trim().toLowerCase() === folded),
  )?.key;
};

const findTaskKey = (
  tasks: ReturnType<typeof buildDecisionRequest>["table"]["tasks"],
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  const folded = value.trim().toLowerCase();
  return tasks.find(
    (task) =>
      task.title.toLowerCase() === folded ||
      task.names.some((name) => name.trim().toLowerCase() === folded),
  )?.key;
};

const answersFor = (
  fixture: CirceSemanticProposal,
  table: ReturnType<typeof buildDecisionRequest>["table"],
): DecisionAnswers => {
  const destination = fixture.refs.find((ref) => ref.role === "destination");
  const excluded = fixture.refs.find((ref) => ref.role === "excluded");
  const task = fixture.refs.find((ref) => ref.role === "task");
  const provider = fixture.refs.find((ref) => ref.role === "provider");
  const targetValue = excluded?.value ?? destination?.value;
  const strategy =
    fixture.action === "converse"
      ? "conversation_thread"
      : fixture.action === "lookup" || fixture.action === "open-website"
        ? "tool"
        : fixture.action === "unsupported"
          ? "refuse"
          : "act";
  const answers: Record<string, DecisionAnswer> = {
    action: choice(fixture.action),
    destination_project: choice(findProjectKey(table.projects, targetValue) ?? "none"),
    destination_negated: noul(excluded === undefined ? 0.02 : 0.98),
    task: choice(findTaskKey(table.tasks, task?.value) ?? "none"),
    provider: choice(
      table.providers.find((entry) =>
        entry.names.some((name) => name.toLowerCase() === provider?.value.toLowerCase()),
      )?.key ?? "none",
    ),
    model_specified: noul(fixture.model === null ? 0.02 : 0.98),
    model: choice(
      fixture.model === null
        ? "none"
        : (table.providers
            .flatMap((entry) => entry.models)
            .find((model) => model.slug === fixture.model)?.key ?? "none"),
    ),
    effort_specified: noul(fixture.effort === null ? 0.02 : 0.98),
    effort: choice(
      fixture.effort === null
        ? "none"
        : (table.efforts.find((entry) => entry.id === fixture.effort)?.key ?? "none"),
    ),
    is_compound: noul(0.02),
    response_strategy: choice(strategy),
    tool: choice(
      fixture.action === "lookup"
        ? (fixture.lookup?.kind ?? "weather")
        : fixture.action === "open-website"
          ? "open-website"
          : "none",
    ),
    contains_approval_verdict: noul(0.02),
    approval_verdict: choice("none"),
    needs_clarification: noul(0.02),
  };
  if (fixture.lookup !== undefined && fixture.lookup !== null) {
    answers[`tool_${fixture.lookup.kind}_location`] = choice(fixture.lookup.location);
    answers[`tool_${fixture.lookup.kind}_day`] = choice(fixture.lookup.day);
  }
  if (fixture.website !== undefined && fixture.website !== null) {
    answers["tool_open-website_website"] = choice(fixture.website);
  }
  return answers;
};

interface Tally {
  total: number;
  passed: number;
  actionCorrect: number;
  projectCorrect: number;
  skipped: number;
}

describe("decision tier offline corpus", () => {
  it("reproduces the expected command without dispatching excluded targets", () => {
    const tally: Tally = { total: 0, passed: 0, actionCorrect: 0, projectCorrect: 0, skipped: 0 };
    const failures: Array<string> = [];
    for (const testCase of circeSemanticDevCorpus) {
      const raw = testCase.fixtureProposal;
      if (raw === undefined) {
        tally.skipped += 1;
        continue;
      }
      let fixture: CirceSemanticProposal;
      try {
        fixture = decodeCirceSemanticProposal(raw);
      } catch {
        tally.skipped += 1;
        continue;
      }
      if (
        fixture.action === "sequence" ||
        fixture.action === "converse" ||
        testCase.expectClarification === true
      ) {
        // Sequences need the second request; converse is the provider's job
        // and carries no classifier-authored answer by design.
        tally.skipped += 1;
        continue;
      }
      const context = buildEvalContext({
        utterance: testCase.utterance,
        aliases: testCase.context?.aliases,
        voice: testCase.context?.voice,
        pendingApproval: testCase.context?.pendingApproval,
        continueContext: testCase.context?.continueContext,
      });
      const built = buildDecisionRequest({
        state: decisionStateFromContext(context, testCase.utterance),
        catalog: decisionCatalogFromContext(context),
      });
      const composed = composeDecision({
        source: testCase.utterance,
        table: built.table,
        answers: answersFor(fixture, built.table),
        boundaries: built.boundaries,
        state: decisionStateFromContext(context, testCase.utterance),
      });
      tally.total += 1;
      if (composed.status !== "proposal") {
        failures.push(`${testCase.id}: composer asked instead of proposing`);
        continue;
      }
      const result = scoreProposal(testCase, composed.proposal, "offline-fixture");
      if (result.actionCorrect === true) tally.actionCorrect += 1;
      if (result.projectCorrect === true) tally.projectCorrect += 1;
      if (result.safety?.exclusionDispatch === true) {
        failures.push(`${testCase.id}: dispatched an excluded project`);
      }
      if (result.verdict === "pass") tally.passed += 1;
      else failures.push(`${testCase.id}: ${result.verdict}`);
    }
    // Recorded evidence, not a tuned gate: the deterministic derivation must
    // not lose any command the classifier got right. Baseline at this commit:
    // 8 scored cases, 5 skipped (1 sequence, 4 converse), 8/8 pass, 8/8 action.
    expect(failures, failures.join("\n")).toEqual([]);
    expect(tally.total).toBeGreaterThan(0);
    expect(tally.passed).toBe(tally.total);
    expect(tally.actionCorrect).toBe(tally.total);
  });
});
