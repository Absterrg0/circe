import { describe, expect, it } from "vite-plus/test";

import type { DecisionAnswer, DecisionAnswers } from "./decision.ts";
import { composeDecision } from "./decisionCompose.ts";
import { buildOptionTable, candidateBoundaries, segmentUtterance } from "./decisionRequest.ts";
import { NONE_OPTION } from "./toolRegistry.ts";

const table = buildOptionTable({
  projects: [
    { title: "Rivvl", names: ["Rivvl"] },
    { title: "Alertify", names: ["Alertify"] },
  ],
  tasks: [{ title: "Authentication", names: ["Authentication", "auth"] }],
  providers: [{ names: ["Codex"], models: [{ slug: "gpt-5-sol", label: "Sol" }] }],
  efforts: [{ id: "high", label: "High" }],
});

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});

const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const none = (confidence = 0.9): DecisionAnswer => choice(NONE_OPTION, confidence);

function answers(prefix: string, overrides: Record<string, DecisionAnswer> = {}): DecisionAnswers {
  const base: Record<string, DecisionAnswer> = {
    action: choice("start"),
    destination_project: none(),
    destination_negated: noul(0.05),
    task: none(),
    provider: none(),
    model_specified: noul(0.05),
    model: none(),
    effort_specified: noul(0.05),
    effort: none(),
    is_compound: noul(0.05),
    response_strategy: choice("act"),
    tool: none(),
    contains_approval_verdict: noul(0.02),
    approval_verdict: none(),
    needs_clarification: noul(0.05),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).map(([key, value]) => [`${prefix}${key}`, value]));
}

const state = {
  utterance: "check auth in Rivvl",
  currentProjectKey: "Rivvl",
  focusedTaskKey: null,
  pendingRequest: "none" as const,
  continueContext: false,
};

describe("composeDecision", () => {
  it("derives a host-located destination span for a start", () => {
    const source = "check auth in Rivvl";
    const result = composeDecision({
      source,
      table,
      boundaries: [],
      state,
      answers: answers("", { destination_project: choice("Rivvl") }),
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.action).toBe("start");
    const destination = result.proposal.refs.find((ref) => ref.role === "destination");
    expect(destination?.span.text).toBe(" in Rivvl");
    expect(destination?.value).toBe("Rivvl");
    expect(source.slice(destination!.span.start, destination!.span.end)).toBe(" in Rivvl");
  });

  it("turns a negated target into an excluded ref, never a route", () => {
    const source = "check auth in Rivvl, but not Alertify";
    const result = composeDecision({
      source,
      table,
      boundaries: [],
      state,
      answers: answers("", {
        destination_project: choice("Alertify"),
        destination_negated: noul(0.95),
      }),
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.refs.some((ref) => ref.role === "destination")).toBe(false);
    expect(result.proposal.refs.find((ref) => ref.role === "excluded")?.value).toBe("Alertify");
  });

  it("asks instead of dispatching when the action confidence is low", () => {
    const source = "check auth in Rivvl";
    const result = composeDecision({
      source,
      table,
      boundaries: [],
      state,
      answers: answers("", { action: choice("start", 0.4), destination_project: choice("Rivvl") }),
    });
    expect(result.status).toBe("needs-input");
  });

  it("asks when a destructive action does not clear its higher threshold", () => {
    const source = "stop authentication";
    const stopAnswers = answers("", {
      action: choice("stop", 0.7),
      task: choice("Authentication"),
    });
    const result = composeDecision({ source, table, boundaries: [], state, answers: stopAnswers });
    expect(result.status).toBe("needs-input");
  });

  it("accepts a destructive action that clears the threshold", () => {
    const source = "stop authentication";
    const result = composeDecision({
      source,
      table,
      boundaries: [],
      state,
      answers: answers("", { action: choice("stop", 0.92), task: choice("Authentication") }),
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.action).toBe("stop");
    expect(result.proposal.refs.find((ref) => ref.role === "task")?.value).toBe("Authentication");
  });

  it("resolves a tool selection to a lookup with a located place", () => {
    const source = "what is the weather in Ahmedabad";
    const result = composeDecision({
      source,
      table,
      boundaries: [],
      state: { ...state, utterance: source },
      answers: answers("", {
        response_strategy: choice("tool"),
        tool: choice("weather"),
        tool_weather_location: choice("Ahmedabad"),
        tool_weather_day: choice("now"),
      }),
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.action).toBe("lookup");
    expect(result.proposal.lookup).toEqual({ kind: "weather", location: "Ahmedabad", day: "now" });
  });

  it("marks a lookup missing its place as a lookup refinement", () => {
    const source = "what's the weather";
    const result = composeDecision({
      source,
      table,
      boundaries: [],
      state: { ...state, utterance: source },
      answers: answers("", {
        response_strategy: choice("tool"),
        tool: choice("weather"),
      }),
    });
    expect(result.status).toBe("needs-input");
    if (result.status !== "needs-input") return;
    expect(result.refinement).toEqual({ kind: "lookup", lookupKind: "weather" });
  });

  it("marks a launch missing its site as a website refinement", () => {
    const source = "open it";
    const result = composeDecision({
      source,
      table,
      boundaries: [],
      state: { ...state, utterance: source },
      answers: answers("", {
        response_strategy: choice("tool"),
        tool: choice("open-website"),
      }),
    });
    expect(result.status).toBe("needs-input");
    if (result.status !== "needs-input") return;
    expect(result.refinement).toEqual({ kind: "website" });
  });

  it("never grants an approval from the classifier", () => {
    const source = "yes allow it";
    const result = composeDecision({
      source,
      table,
      boundaries: [],
      state: { ...state, pendingRequest: "approval" },
      answers: answers("", {
        contains_approval_verdict: noul(0.95),
        approval_verdict: choice("allow"),
      }),
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.action).toBe("continue");
    expect(result.proposal.refs).toHaveLength(0);
  });

  it("composes a compound into ordered sequence steps with host spans", () => {
    const source = "stop auth, then create a deployment task";
    const boundaries = candidateBoundaries(source).filter(
      (boundary) => source[boundary.matchStart] === ",",
    );
    const segments = segmentUtterance(source, boundaries);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    const segmentAnswers = segments.map((_, index) =>
      answers(`seg${index}_`, {
        action: index === 0 ? choice("stop", 0.92) : choice("start", 0.9),
        task: index === 0 ? choice("Authentication") : none(),
      }),
    );
    const result = composeDecision({
      source,
      table,
      boundaries,
      segments,
      segmentAnswers,
      state: { ...state, utterance: source },
    });
    expect(result.status).toBe("proposal");
    if (result.status !== "proposal") return;
    expect(result.proposal.action).toBe("sequence");
    const steps = result.proposal.steps ?? [];
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const step of steps) {
      expect(step.sourceSpan).toBeDefined();
      expect(
        source.slice(step.sourceSpan!.start, step.sourceSpan!.end).trim().length,
      ).toBeGreaterThan(0);
    }
  });

  it("is deterministic: same decision yields the same proposal and spans", () => {
    const source = "check auth in Rivvl";
    const input = {
      source,
      table,
      boundaries: [] as const,
      state,
      answers: answers("", { destination_project: choice("Rivvl") }),
    };
    const first = composeDecision(input);
    const second = composeDecision(input);
    expect(second).toEqual(first);
  });
});
