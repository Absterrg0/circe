import { describe, expect, it } from "vite-plus/test";

import type { DecisionAnswer } from "../decision.ts";
import { composeModelRoute, pickRoute, type ModelRouteCandidate } from "./modelRoutingDecision.ts";

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const candidates: ReadonlyArray<ModelRouteCandidate> = [
  {
    provider: "Codex",
    model: "gpt-5.6-sol",
    key: "Codex/gpt-5.6-sol",
    isDefault: true,
    costRank: 0.8,
    speedRank: 0.4,
    qualityRank: 0.9,
  },
  {
    provider: "OpenCode",
    model: "flash",
    key: "OpenCode/flash",
    costRank: 0.1,
    speedRank: 0.9,
    qualityRank: 0.3,
  },
  {
    provider: "Claude",
    model: "sonnet",
    key: "Claude/sonnet",
    costRank: 0.5,
    speedRank: 0.5,
    qualityRank: 0.8,
  },
];

const answers = (overrides: Record<string, DecisionAnswer> = {}) => ({
  priority: choice("cheap"),
  priority_named: noul(0.95),
  is_reasoning_heavy: noul(0.05),
  model: choice("none"),
  user_named_model: noul(0.05),
  ...overrides,
});

describe("model routing decision experiment", () => {
  it("lets a named model win", () => {
    const route = composeModelRoute({
      candidates,
      answers: answers({ model: choice("Claude/sonnet"), user_named_model: noul(0.98) }),
    });
    expect(route.status).toBe("routed");
    if (route.status !== "routed") return;
    expect(route.key).toBe("Claude/sonnet");
  });

  it("picks the cheapest and the fastest by rank", () => {
    expect(pickRoute({ candidates, priority: "cheap" })?.key).toBe("OpenCode/flash");
    expect(pickRoute({ candidates, priority: "fast" })?.key).toBe("OpenCode/flash");
    expect(pickRoute({ candidates, priority: "best" })?.key).toBe("Codex/gpt-5.6-sol");
  });

  it("falls back to the default when no rating data exists", () => {
    const route = composeModelRoute({
      candidates: [{ provider: "X", model: "y", key: "X/y", isDefault: true }],
      answers: answers(),
    });
    expect(route.status).toBe("routed");
    if (route.status !== "routed") return;
    expect(route.key).toBe("X/y");
    expect(route.reason).toContain("No cheap rating");
  });

  it("does not take the cheapest model for a reasoning-heavy task", () => {
    const route = composeModelRoute({
      candidates,
      answers: answers({ is_reasoning_heavy: noul(0.95) }),
    });
    expect(route.status).toBe("routed");
    if (route.status !== "routed") return;
    expect(route.key).toBe("Codex/gpt-5.6-sol");
    expect(route.priority).toBe("best");
  });
});
