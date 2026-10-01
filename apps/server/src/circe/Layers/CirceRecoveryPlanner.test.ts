import type { ComputerRecoveryInput } from "@circe/core/computerUse";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRecoveryPrompt,
  CirceRecoveryPlan,
  desktopPlanFailureReason,
} from "./CirceRecoveryPlanner.ts";

const input: ComputerRecoveryInput = {
  goal: "save the notes file",
  reason: "refused",
  history: ["clicked ax:1"],
  surface: {
    kind: "desktop",
    title: "Editor",
    elements: [
      { id: "ax:1", role: "button", name: "Save", bounds: { x: 0, y: 0, width: 10, height: 10 } },
      {
        id: "ax:2",
        role: "entry",
        name: "Heading",
        bounds: { x: 0, y: 20, width: 10, height: 10 },
      },
    ],
  },
};

describe("circe recovery planner", () => {
  it("builds a bounded, id-only prompt", () => {
    const prompt = buildRecoveryPrompt(input);
    expect(prompt).toContain("save the notes file");
    expect(prompt).toContain("ax:1");
    expect(prompt).toContain("Every elementId must be one of the observed element ids");
    expect(prompt).toContain("Do not repeat attempted steps");
  });

  it("accepts a grounded plan and rejects an out-of-shape one", () => {
    const decoded = Schema.decodeUnknownSync(CirceRecoveryPlan)({
      steps: [
        { kind: "click", elementId: "ax:1" },
        { kind: "press", elementId: "ax:1", key: "enter" },
        { kind: "wait" },
      ],
    });
    expect(decoded.steps).toHaveLength(3);
    expect(() =>
      Schema.decodeUnknownSync(CirceRecoveryPlan)({
        steps: [{ kind: "click" }, { kind: "unknown" }],
      }),
    ).toThrow();
  });

  it("bounds the plan length", () => {
    expect(() =>
      Schema.decodeUnknownSync(CirceRecoveryPlan)({
        steps: Array.from({ length: 5 }, () => ({ kind: "wait" as const })),
      }),
    ).toThrow();
  });

  it("reports the provider's own reason when desktop planning fails", () => {
    const detail = [
      "Codex CLI command failed: OpenAI Codex v0.159.2",
      "user",
      "Plan how to carry out a goal on a computer's desktop.",
      "ERROR: Goal: echoed prompt text that is not the cause",
      "warning: Code Mode is unavailable because code-mode host is disabled.",
      "ERROR: You've hit your usage limit. Try again at 9:48 PM.",
    ].join("\n");
    expect(desktopPlanFailureReason("gpt-5.6-luna", detail)).toBe(
      "the planning model gpt-5.6-luna failed: You've hit your usage limit. Try again at 9:48 PM.",
    );
    expect(desktopPlanFailureReason("gpt-5.6-luna", "Codex CLI command failed with code 1.")).toBe(
      "the planning model gpt-5.6-luna failed",
    );
  });
});
