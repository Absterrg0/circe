import { describe, expect, it } from "vite-plus/test";

import type { DecisionAnswer } from "../decision.ts";
import {
  composeDeliveryPlan,
  type DeliveryAttention,
  type DeliveryOutcome,
} from "./deliveryDecision.ts";

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const focused: DeliveryAttention = {
  appState: "active",
  visible: true,
  focused: true,
  recentlyInteracted: true,
  voiceEnabled: true,
  liveSessionActive: false,
  alreadySpeaking: false,
};
const away: DeliveryAttention = {
  appState: "background",
  visible: false,
  focused: false,
  recentlyInteracted: false,
  voiceEnabled: true,
  liveSessionActive: false,
  alreadySpeaking: false,
};

const answers = (overrides: Record<string, DecisionAnswer> = {}) => ({
  channel: choice("speak"),
  timing: choice("now"),
  user_is_attending: noul(0.95),
  same_thread: noul(0.95),
  work_is_finished: noul(0.05),
  ...overrides,
});

const failed: DeliveryOutcome = {
  kind: "failed",
  threadRelation: "focused",
  actionable: true,
  urgent: false,
};
const completed: DeliveryOutcome = {
  kind: "completed",
  threadRelation: "focused",
  actionable: false,
  urgent: false,
};

describe("delivery decision experiment", () => {
  it("speaks an actionable failure to an attending user", () => {
    const plan = composeDeliveryPlan({ outcome: failed, attention: focused, answers: answers() });
    expect(plan.channel).toBe("speak");
  });

  it("pushes an actionable failure when the user is away", () => {
    const plan = composeDeliveryPlan({
      outcome: { ...failed, threadRelation: "unfocused" },
      attention: away,
      answers: answers({ user_is_attending: noul(0.05), same_thread: noul(0.05) }),
    });
    expect(plan.channel).toBe("push");
  });

  it("stays silent for a completed result the focused user can already see", () => {
    const plan = composeDeliveryPlan({
      outcome: completed,
      attention: focused,
      answers: answers(),
    });
    expect(plan.channel).toBe("silent");
  });

  it("never speaks while speech is active", () => {
    const plan = composeDeliveryPlan({
      outcome: failed,
      attention: { ...focused, alreadySpeaking: true },
      answers: answers(),
    });
    expect(plan.channel).not.toBe("speak");
    expect(plan.timing).toBe("queue");
  });

  it("overrides a speak choice from the background", () => {
    const plan = composeDeliveryPlan({
      outcome: { ...completed, threadRelation: "unfocused" },
      attention: away,
      answers: answers({ channel: choice("speak"), same_thread: noul(0.05) }),
    });
    expect(plan.channel).toBe("push");
  });
});
