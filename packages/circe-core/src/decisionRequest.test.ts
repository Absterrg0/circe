import { describe, expect, it } from "vite-plus/test";

import type { DecisionQuestion } from "./decision.ts";
import {
  CIRCE_DECISION_THRESHOLDS,
  buildDecisionRequest,
  buildOptionTable,
  candidateBoundaries,
  locateDestinationWrapper,
  locateNameSpan,
  riskForAction,
  segmentUtterance,
  thresholdForRisk,
  type DecisionCatalog,
} from "./decisionRequest.ts";
import { NONE_OPTION } from "./toolRegistry.ts";

const catalog: DecisionCatalog = {
  projects: [
    { title: "Rivvl", names: ["Rivvl", "rivvl-app"] },
    { title: "Alertify", names: ["Alertify"] },
  ],
  tasks: [{ title: "Rivvl authentication", names: ["Rivvl authentication", "auth"] }],
  providers: [
    {
      names: ["Codex", "codex"],
      models: [{ slug: "gpt-5-sol", label: "Sol" }],
    },
  ],
  efforts: [{ id: "high", label: "High" }],
};

const baseState = {
  utterance: "check auth in Rivvl",
  currentProjectKey: "Rivvl",
  focusedTaskKey: null,
  pendingRequest: "none" as const,
  continueContext: false,
};

const choiceOptions = (question: DecisionQuestion): ReadonlyArray<string> => {
  if (question.type !== "choice") return [];
  return Object.keys(question.criteria);
};

describe("buildDecisionRequest invariants", () => {
  it("keeps every option set non-empty, closed, and free of duplicates", () => {
    const { request } = buildDecisionRequest({ state: baseState, catalog });
    const questions = Object.values(request.questions);
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) {
      expect(question.instructions.trim().length).toBeGreaterThan(0);
      if (question.type !== "choice") continue;
      const options = choiceOptions(question);
      expect(options.length).toBeGreaterThan(1);
      expect(new Set(options).size).toBe(options.length);
    }
  });

  it("offers an explicit none option wherever a target is optional", () => {
    const { request } = buildDecisionRequest({ state: baseState, catalog });
    expect(choiceOptions(request.questions.destination_project!)).toContain(NONE_OPTION);
    expect(choiceOptions(request.questions.task!)).toContain(NONE_OPTION);
    expect(choiceOptions(request.questions.provider!)).toContain(NONE_OPTION);
    expect(choiceOptions(request.questions.tool!)).toContain(NONE_OPTION);
  });

  it("never exposes an internal id as an option key", () => {
    const { request } = buildDecisionRequest({ state: baseState, catalog });
    const projectOptions = choiceOptions(request.questions.destination_project!);
    expect(projectOptions).toEqual(expect.arrayContaining(["Rivvl", "Alertify", NONE_OPTION]));
  });

  it("is deterministic: same state and catalog produce the same request", () => {
    const first = buildDecisionRequest({ state: baseState, catalog });
    const second = buildDecisionRequest({ state: baseState, catalog });
    expect(second.request).toEqual(first.request);
    expect(second.table).toEqual(first.table);
  });

  it("qualifies duplicate project keys without colliding", () => {
    const table = buildOptionTable({
      projects: [
        { title: "Circe", names: ["Circe"], qualifier: "node-a" },
        { title: "Circe", names: ["Circe"], qualifier: "node-b" },
      ],
      tasks: [],
      providers: [],
    });
    const keys = table.projects.map((project) => project.key);
    expect(new Set(keys).size).toBe(2);
  });
});

describe("locate is total", () => {
  it("locates a name as a whole-token phrase with exact offsets", () => {
    const source = "check auth in Rivvl";
    const span = locateNameSpan(source, "Rivvl");
    expect(span).toBeDefined();
    expect(source.slice(span!.start, span!.end)).toBe(span!.text);
    expect(span!.text).toBe("Rivvl");
  });

  it("returns undefined when the name is absent instead of guessing", () => {
    expect(locateNameSpan("check auth in Rivvl", "Fable")).toBeUndefined();
  });

  it("expands a destination to its spoken wrapper", () => {
    const source = "check auth in Rivvl";
    const wrapper = locateDestinationWrapper(source, "Rivvl");
    expect(wrapper?.text).toBe(" in Rivvl");
  });
});

describe("segmentation partition law", () => {
  const source = "stop auth, then create a deployment task";

  it("finds candidate boundaries with text on both sides", () => {
    const boundaries = candidateBoundaries(source);
    expect(boundaries.length).toBeGreaterThan(0);
    for (const boundary of boundaries) {
      expect(boundary.left.length).toBeGreaterThan(0);
      expect(boundary.right.length).toBeGreaterThan(0);
    }
  });

  it("produces contiguous, non-overlapping, bounded segments", () => {
    const boundaries = candidateBoundaries(source).filter(
      (boundary) => source[boundary.matchStart] === "," || boundary.left.endsWith(","),
    );
    const segments = segmentUtterance(source, boundaries);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.length).toBeLessThanOrEqual(4);
    for (const [index, segment] of segments.entries()) {
      expect(source.slice(segment.start, segment.end)).toBe(segment.text);
      const previous = segments[index - 1];
      if (previous !== undefined) expect(segment.start).toBeGreaterThanOrEqual(previous.end);
    }
  });

  it("falls back to one whole segment when fewer than two survive", () => {
    const segments = segmentUtterance(source, []);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe(source);
  });
});

describe("monotone safety", () => {
  it("keeps confidence thresholds non-decreasing in risk", () => {
    expect(CIRCE_DECISION_THRESHOLDS.readOnly).toBeLessThanOrEqual(
      CIRCE_DECISION_THRESHOLDS.mutating,
    );
    expect(CIRCE_DECISION_THRESHOLDS.mutating).toBeLessThanOrEqual(
      CIRCE_DECISION_THRESHOLDS.destructive,
    );
  });

  it("rates stop and reroute destructive and status read-only", () => {
    expect(riskForAction("stop")).toBe("destructive");
    expect(riskForAction("reroute")).toBe("destructive");
    expect(riskForAction("status")).toBe("read-only");
    expect(thresholdForRisk("destructive")).toBe(CIRCE_DECISION_THRESHOLDS.destructive);
  });
});
