import { describe, expect, it } from "vite-plus/test";

import type { DecisionAnswer } from "../decision.ts";
import {
  composeApprovalPlan,
  effectiveRiskTier,
  type ApprovalRequestSummary,
} from "./approvalDecision.ts";

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const answers = (overrides: Record<string, DecisionAnswer> = {}) => ({
  risk: choice("workspace-write"),
  grant_scope: choice("allow-edits"),
  touches_outside_workspace: noul(0.05),
  irreversible: noul(0.05),
  network_or_secrets: noul(0.05),
  identity_confident: noul(0.95),
  ...overrides,
});

const request = (overrides: Partial<ApprovalRequestSummary> = {}): ApprovalRequestSummary => ({
  requestKind: "file-change",
  toolName: "Edit",
  withinStandingGrant: false,
  ...overrides,
});

describe("approval decision experiment", () => {
  it("never auto-accepts a destructive request", () => {
    const plan = composeApprovalPlan({
      request: request(),
      answers: answers({ risk: choice("destructive") }),
    });
    expect(plan.status).toBe("ask-always");
  });

  it("forces a high tier from an irreversible predicate even if the model said read", () => {
    const tier = effectiveRiskTier(
      answers({ risk: choice("read"), irreversible: noul(0.97) }),
      request({ command: "rm -rf build" }),
    );
    expect(tier).toBe("destructive");
  });

  it("auto-accepts only inside an existing grant", () => {
    const outside = composeApprovalPlan({ request: request(), answers: answers() });
    expect(outside.status).toBe("ask");
    const inside = composeApprovalPlan({
      request: request({ withinStandingGrant: true, standingScope: "allow-edits" }),
      answers: answers(),
    });
    expect(inside.status).toBe("auto-accept");
    if (inside.status !== "auto-accept") return;
    expect(inside.decision).toBe("acceptForSession");
  });

  it("asks for a fresh scope for a network request even inside a grant", () => {
    const plan = composeApprovalPlan({
      request: request({ withinStandingGrant: true, command: "curl https://..." }),
      answers: answers({ risk: choice("external-effect"), network_or_secrets: noul(0.9) }),
    });
    expect(plan.status).toBe("ask");
    if (plan.status !== "ask") return;
    expect(plan.scope).toBe("ask-every-time");
  });

  it("treats a blank request as unknown risk", () => {
    const tier = effectiveRiskTier(answers({ risk: choice("read") }), {
      requestKind: "command",
      withinStandingGrant: true,
    });
    expect(tier).toBe("unknown");
  });
});
