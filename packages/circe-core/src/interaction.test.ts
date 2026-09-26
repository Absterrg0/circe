import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { CirceInteractionState } from "@circe/contracts";

import {
  circeLookupSourceUtterance,
  createLookupInteraction,
  decideCirceInteractionInput,
  resolveCirceInputRelation,
  resolveLookupSlotAnswer,
} from "./interaction.ts";

const now = DateTime.makeUnsafe("2026-09-20T12:00:00Z");
const next = DateTime.makeUnsafe("2026-09-20T12:00:05Z");

const ownerNodeId = "node-1" as CirceInteractionState["ownerNodeId"];
const interactionId = "interaction-1" as CirceInteractionState["interactionId"];

function weatherState(location?: string): CirceInteractionState {
  return createLookupInteraction({
    interactionId,
    ownerNodeId,
    tool: "weather",
    day: "now",
    ...(location === undefined ? {} : { location }),
    now,
  }).state;
}

describe("interaction relation", () => {
  it("treats a bare place answer as an answer, not a new request", () => {
    const state = weatherState();
    expect(resolveCirceInputRelation({ state, utterance: "Ahmedabad" })).toBe("answer");
  });

  it("treats a bare stop as a cancel of the pending question", () => {
    const state = weatherState();
    expect(resolveCirceInputRelation({ state, utterance: "stop" })).toBe("cancel");
    expect(resolveCirceInputRelation({ state, utterance: "never mind" })).toBe("cancel");
  });

  it("treats a complete new command over a project as a new request", () => {
    const state = weatherState();
    expect(
      resolveCirceInputRelation({
        state,
        utterance: "fix the parser in VPS",
        projectNames: ["VPS"],
      }),
    ).toBe("new-request");
  });

  it("treats a correction marker as a correction of the active goal", () => {
    const state = weatherState("Ahmedabad");
    expect(resolveCirceInputRelation({ state, utterance: "actually tomorrow" })).toBe("correction");
  });

  it("treats a bare place after an answer as a correction of the same lookup", () => {
    const state = weatherState("Ahmedabad");
    expect(resolveCirceInputRelation({ state, utterance: "Springfield, Illinois" })).toBe(
      "correction",
    );
    // A question-shaped input stays new work.
    expect(resolveCirceInputRelation({ state, utterance: "what's on my plate" })).toBe(
      "new-request",
    );
    expect(resolveCirceInputRelation({ state, utterance: "which task is running?" })).toBe(
      "new-request",
    );
  });

  it("reads a bare yes as an answer to a pending approval", () => {
    const device = weatherState("Ahmedabad");
    const state: CirceInteractionState = {
      ...device,
      goal: { kind: "device", surface: "computer", goal: "open notes" },
      pending: {
        questionId: "device:approval",
        kind: "approval",
        slot: "approval",
        prompt: "Start?",
        known: {},
        choices: [],
      },
    };
    expect(resolveCirceInputRelation({ state, utterance: "yes" })).toBe("answer");
    expect(resolveCirceInputRelation({ state, utterance: "no thanks" })).toBe("cancel");
  });
});

describe("lookup answer transition", () => {
  it("fills the location slot and resumes the same lookup", () => {
    const state = weatherState();
    const decision = decideCirceInteractionInput({
      state,
      utterance: "Ahmedabad",
      now: next,
    });
    expect(decision.relation).toBe("answer");
    expect(decision.problem).toBeNull();
    expect(decision.effect).toEqual({
      kind: "run-lookup",
      tool: "weather",
      day: "now",
      location: "Ahmedabad",
    });
    expect(decision.state.pending).toBeNull();
    expect(decision.state.revision).toBe(1);
    expect(decision.state.goal).toEqual({
      kind: "lookup",
      tool: "weather",
      day: "now",
      location: "Ahmedabad",
    });
  });

  it("keeps the same question when the answer carries no place", () => {
    const state = weatherState();
    const decision = decideCirceInteractionInput({
      state,
      utterance: "what do you think",
      now: next,
    });
    expect(decision.problem).toBe("answer-had-no-slot");
    expect(decision.state).toBe(state);
    expect(decision.state.revision).toBe(0);
  });

  it("binds an ambiguous place answer to the offered choice", () => {
    const base = weatherState();
    const state: CirceInteractionState = {
      ...base,
      pending: {
        questionId: "lookup:weather:place",
        kind: "choice",
        slot: "location",
        prompt: "Which of those places did you mean?",
        known: { tool: "weather", day: "now" },
        choices: ["Springfield, Illinois", "Springfield, Massachusetts"],
      },
    };
    const decision = decideCirceInteractionInput({
      state,
      utterance: "Springfield, Massachusetts",
      now: next,
    });
    expect(decision.effect).toEqual({
      kind: "run-lookup",
      tool: "weather",
      day: "now",
      location: "Springfield, Massachusetts",
    });
  });

  it("corrects the day while keeping the resolved place", () => {
    const state = weatherState("Ahmedabad");
    const decision = decideCirceInteractionInput({
      state,
      utterance: "actually tomorrow",
      now: next,
    });
    expect(decision.relation).toBe("correction");
    expect(decision.effect).toEqual({
      kind: "run-lookup",
      tool: "weather",
      day: "tomorrow",
      location: "Ahmedabad",
    });
  });

  it("hands a cancel to the owner node without guessing", () => {
    const state = weatherState();
    const decision = decideCirceInteractionInput({ state, utterance: "stop", now: next });
    expect(decision.relation).toBe("cancel");
    // The node decides whether it is stopping a running task or dismissing
    // the pending question; the reducer leaves the state untouched.
    expect(decision.effect).toEqual({ kind: "stop-work" });
    expect(decision.state).toBe(state);
  });

  it("still delegates a stop for a lookup goal to the node", () => {
    const state = weatherState("Ahmedabad");
    const decision = decideCirceInteractionInput({ state, utterance: "stop", now: next });
    expect(decision.effect).toEqual({ kind: "stop-work" });
    expect(decision.state).toBe(state);
  });

  it("retires the question when the user starts unrelated work", () => {
    const state = weatherState();
    const decision = decideCirceInteractionInput({
      state,
      utterance: "fix the parser in VPS",
      projectNames: ["VPS"],
      now: next,
    });
    expect(decision.relation).toBe("new-request");
    expect(decision.effect).toEqual({ kind: "classify", source: "fix the parser in VPS" });
    expect(decision.state.pending).toBeNull();
  });

  it("refuses an answer when nothing is pending and classifies instead", () => {
    const state: CirceInteractionState = { ...weatherState("Ahmedabad"), pending: null };
    const decision = decideCirceInteractionInput({
      state,
      utterance: "yes",
      proposedRelation: "answer",
      now: next,
    });
    expect(decision.relation).toBe("new-request");
    expect(decision.effect.kind).toBe("classify");
  });

  it("keeps an approval answer bound to the device goal", () => {
    const base = weatherState("Ahmedabad");
    const state: CirceInteractionState = {
      ...base,
      goal: { kind: "device", surface: "computer", goal: "open notes" },
      pending: {
        questionId: "device:approval",
        kind: "approval",
        slot: "approval",
        prompt: "Start?",
        known: {},
        choices: [],
      },
    };
    const decision = decideCirceInteractionInput({ state, utterance: "yes", now: next });
    expect(decision.effect).toEqual({
      kind: "start-device",
      surface: "computer",
      goal: "open notes",
    });
    expect(decision.state.pending).toBeNull();
  });
});

describe("lookup slot resolution", () => {
  const question = {
    questionId: "lookup:weather:now",
    kind: "argument" as const,
    slot: "location",
    prompt: "Which city or place?",
    known: { tool: "weather", day: "now" },
    choices: [],
  };

  it("resolves a bare place", () => {
    expect(resolveLookupSlotAnswer({ question, utterance: "London" })).toEqual({
      status: "resolved",
      location: "London",
    });
  });

  it("prefers an offered choice over a fresh extraction", () => {
    expect(
      resolveLookupSlotAnswer({
        question: { ...question, choices: ["Paris, France", "Paris, Texas"] },
        utterance: "Paris, Texas please",
      }),
    ).toEqual({ status: "resolved", location: "Paris, Texas" });
  });

  it("resolves a day answer", () => {
    expect(
      resolveLookupSlotAnswer({
        question: { ...question, slot: "day", choices: [] },
        utterance: "tomorrow please",
      }),
    ).toEqual({ status: "resolved", day: "tomorrow" });
  });

  it("reports several places as ambiguous", () => {
    expect(resolveLookupSlotAnswer({ question, utterance: "Paris and London" })).toEqual({
      status: "ambiguous",
      choices: ["Paris", "London"],
    });
  });

  it("does not treat a lookup goal itself as a place", () => {
    expect(resolveLookupSlotAnswer({ question, utterance: "check the weather" })).toEqual({
      status: "missing",
    });
  });
});

describe("lookup source grounding", () => {
  it("keeps an already-resolved place in the source a correction is grounded against", () => {
    const goal = {
      kind: "lookup" as const,
      tool: "weather" as const,
      day: "now" as const,
      location: "Ahmedabad",
    };
    expect(circeLookupSourceUtterance(goal, "actually tomorrow")).toBe(
      "Ahmedabad. actually tomorrow",
    );
    expect(circeLookupSourceUtterance(goal, "what about Ahmedabad tomorrow")).toBe(
      "what about Ahmedabad tomorrow",
    );
    expect(
      circeLookupSourceUtterance({ kind: "lookup", tool: "weather", day: "now" }, "tomorrow"),
    ).toBe("tomorrow");
  });
});

describe("interaction revision", () => {
  it("does not advance the revision for an answer that carries no slot", () => {
    const state = weatherState();
    const first = decideCirceInteractionInput({ state, utterance: "hmm", now });
    const second = decideCirceInteractionInput({
      state: first.state,
      utterance: "maybe",
      now,
    });
    expect(second.state.revision).toBe(0);
  });

  it("advances once per consumed transition, so a replayed answer is a store conflict", () => {
    const state = weatherState();
    const first = decideCirceInteractionInput({ state, utterance: "Ahmedabad", now });
    expect(first.state.revision).toBe(1);
    // The reducer is pure: replaying from the same revision computes the same
    // next revision. The store's compare-and-set is what rejects the replay.
    const replay = decideCirceInteractionInput({ state, utterance: "London", now });
    expect(replay.state.revision).toBe(1);
    expect(replay.state.goal).toEqual({
      kind: "lookup",
      tool: "weather",
      day: "now",
      location: "London",
    });
  });
});
