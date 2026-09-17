import { describe, expect, it } from "vite-plus/test";

import type { DecisionAnswer } from "../decision.ts";
import {
  composeAttentionBriefing,
  rankedAttentionTasks,
  type AttentionTask,
} from "./attentionDecision.ts";

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const tasks: ReadonlyArray<AttentionTask> = [
  { key: "Release docs", state: "running" },
  { key: "Rivvl authentication", state: "waiting-for-approval", approvalDestructive: true },
  { key: "Landing page", state: "ready", unreadResult: true },
];

const answers = (overrides: Record<string, DecisionAnswer> = {}) => ({
  lead_task: choice("Rivvl authentication"),
  lead_reason: choice("approval"),
  needs_user: noul(0.95),
  ...overrides,
});

describe("attention decision experiment", () => {
  it("ranks an approval above running and unseen work", () => {
    const ranked = rankedAttentionTasks(tasks);
    expect(ranked[0]?.task.key).toBe("Rivvl authentication");
    expect(ranked[0]?.reason).toBe("approval");
  });

  it("overrides a model pick that ignores a higher-band approval", () => {
    const briefing = composeAttentionBriefing({
      tasks,
      answers: answers({ lead_task: choice("Release docs"), lead_reason: choice("running") }),
    });
    expect(briefing.status).toBe("briefing");
    if (briefing.status !== "briefing") return;
    expect(briefing.lead.key).toBe("Rivvl authentication");
    expect(briefing.reason).toBe("approval");
  });

  it("reports clear when nothing is blocked on the user", () => {
    const briefing = composeAttentionBriefing({
      tasks: [
        { key: "Release docs", state: "running" },
        { key: "Landing page", state: "ready", unreadResult: false },
      ],
      answers: answers({
        lead_task: choice("none"),
        lead_reason: choice("nothing"),
        needs_user: noul(0.05),
      }),
    });
    expect(briefing.status).toBe("clear");
  });

  it("composes the line from typed state", () => {
    const briefing = composeAttentionBriefing({ tasks, answers: answers() });
    expect(briefing.status).toBe("briefing");
    if (briefing.status !== "briefing") return;
    expect(briefing.line).toContain("waiting for approval");
    expect(briefing.line).toContain("destructive");
  });
});
