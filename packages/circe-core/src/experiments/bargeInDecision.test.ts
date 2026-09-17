import { describe, expect, it } from "vite-plus/test";

import type { DecisionAnswer } from "../decision.ts";
import { composeBargeInAction, type BargeInContext } from "./bargeInDecision.ts";

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({
  type: "choice",
  choice: value,
  probabilities: { [value]: confidence },
  confidence,
});
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

const context: BargeInContext = {
  transcript: "stop",
  assistantSpeaking: true,
  taskRunning: true,
  hasPendingRequest: false,
  priorRequestActive: false,
};

const answers = (intent: string, overrides: Record<string, DecisionAnswer> = {}) => ({
  intent: choice(intent),
  addressed_to_circe: noul(0.95),
  is_backchannel_only: noul(0.05),
  cancels_prior: noul(0.05),
  ...overrides,
});

describe("barge-in decision experiment", () => {
  it("always interrupts on stop", () => {
    expect(composeBargeInAction({ context, answers: answers("stop") }).status).toBe("interrupt");
  });

  it("never interrupts a backchannel", () => {
    const action = composeBargeInAction({
      context,
      answers: answers("backchannel", { is_backchannel_only: noul(0.95) }),
    });
    expect(action.status).toBe("ignore");
  });

  it("routes an answer only when something is waiting", () => {
    expect(composeBargeInAction({ context, answers: answers("answer") }).status).toBe("ignore");
    expect(
      composeBargeInAction({
        context: { ...context, hasPendingRequest: true },
        answers: answers("answer"),
      }).status,
    ).toBe("route");
  });

  it("queues a command instead of interrupting speech", () => {
    expect(composeBargeInAction({ context, answers: answers("command") }).status).toBe("queue");
  });

  it("ignores speech that is not addressed to Circe", () => {
    const action = composeBargeInAction({
      context,
      answers: answers("command", { addressed_to_circe: noul(0.05) }),
    });
    expect(action.status).toBe("ignore");
  });

  it("treats uncertain speech during playback as a backchannel", () => {
    const action = composeBargeInAction({
      context,
      answers: answers("command", { intent: choice("command", 0.3) }),
    });
    expect(action.status).toBe("ignore");
  });
});
