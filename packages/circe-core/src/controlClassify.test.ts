import { describe, expect, it } from "vite-plus/test";

import type { CirceCommand } from "./command.ts";
import {
  buildCirceOutcomeRequest,
  circeOutcomeFromProposal,
  composeCirceOutcome,
  offeredCirceTools,
  type CirceWorkResolution,
} from "./controlClassify.ts";
import type { CirceTool } from "./controlTools.ts";
import type { DecisionCatalog } from "./decisionRequest.ts";
import type { CirceSemanticProposal } from "./semanticEvidence.ts";

const emptyCatalog: DecisionCatalog = { projects: [], tasks: [], providers: [], efforts: [] };

const locationCandidates = ["Ahmedabad", "Paris"];
const websiteCandidates = ["YouTube"];

const offered = (): ReadonlyArray<CirceTool> =>
  offeredCirceTools({
    nodeTools: ["weather", "time", "task-status", "list-projects"],
    clientTools: [
      "open-website",
      "open-app",
      "media",
      "clipboard",
      "browse",
      "preview",
      "computer",
    ],
    locationCandidates,
    websiteCandidates,
  });

const choice = (answer: string, confidence = 0.95) =>
  ({ type: "choice", choice: answer, probabilities: {}, confidence }) as const;

const workRefusal: CirceWorkResolution = {
  status: "commands",
  commands: [{ type: "list-projects" }],
};

describe("offered tools", () => {
  it("only offers tools whose host advertised the capability", () => {
    const tools = offeredCirceTools({
      nodeTools: ["weather"],
      clientTools: [],
      locationCandidates,
      websiteCandidates,
    });
    expect(tools.map((tool) => tool.name)).toEqual(["weather"]);
  });

  it("offers a bounded tool only when its host advertised the capability", () => {
    // open-app has no client-supplied candidate set, so it cannot close a
    // Choice and is not offered; a residual goal does not need one because
    // the host derives it from the user's own instruction.
    const names = offered().map((tool) => tool.name);
    expect(names).toContain("weather");
    expect(names).toContain("open-website");
    expect(names).toContain("browse");
    expect(names).toContain("computer");
    // An optional text argument is still closed: media can run without a target.
    expect(names).toContain("media");
    expect(names).not.toContain("open-app");
  });

  it("keeps a lookup tool offered with no place candidates and asks a typed question", () => {
    const state = {
      utterance: "what is the weather",
      currentProjectKey: null,
      focusedTaskKey: null,
      pendingRequest: "none" as const,
      continueContext: false,
    };
    const catalog: DecisionCatalog = {
      projects: [],
      tasks: [],
      providers: [],
      efforts: [],
    };
    const built = buildCirceOutcomeRequest({
      state,
      catalog,
      nodeTools: ["weather"],
      clientTools: [],
      locationCandidates: [],
      websiteCandidates: [],
    });
    const outcome = built.request.questions.outcome;
    expect(outcome?.type).toBe("choice");
    if (outcome?.type !== "choice") return;
    expect(Object.keys(outcome.criteria)).toContain("weather");
    const composed = composeCirceOutcome({
      source: state.utterance,
      state,
      table: built.table,
      boundaries: built.boundaries,
      answers: { outcome: choice("weather") },
      tools: built.tools,
      locationCandidates: [],
      websiteCandidates: [],
      work: () => workRefusal,
    });
    expect(composed.kind).toBe("clarification");
    if (composed.kind !== "clarification") return;
    expect(composed.clarification.kind).toBe("lookup");
  });
});

describe("the single outcome request", () => {
  it("selects among work, conversation, refusal, clarification, and offered tools", () => {
    const built = buildCirceOutcomeRequest({
      state: {
        utterance: "weather in Paris",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      catalog: emptyCatalog,
      nodeTools: ["weather"],
      clientTools: ["open-website"],
      locationCandidates,
      websiteCandidates,
    });
    const outcome = built.request.questions.outcome;
    expect(outcome?.type).toBe("choice");
    if (outcome?.type !== "choice") return;
    expect(Object.keys(outcome.criteria)).toEqual(
      expect.arrayContaining([
        "work",
        "conversation",
        "refusal",
        "clarification",
        "weather",
        "open-website",
      ]),
    );
    // Every tool argument is a closed Choice or Noul, never free text.
    expect(built.request.questions.tool_weather_location?.type).toBe("choice");
    expect(built.request.questions.tool_weather_day?.type).toBe("choice");
  });
});

describe("composing one CirceOutcome", () => {
  it("resolves an offered node tool into a tool-answer with grounded args", () => {
    const outcome = composeCirceOutcome({
      source: "what is the weather in Paris",
      state: {
        utterance: "what is the weather in Paris",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: {
        outcome: choice("weather"),
        tool_weather_location: choice("Paris"),
        tool_weather_day: choice("now"),
      },
      tools: offered(),
      locationCandidates,
      websiteCandidates,
      work: () => workRefusal,
    });
    expect(outcome).toEqual({
      kind: "tool-answer",
      host: "node",
      tool: "weather",
      risk: "read-only",
      args: { location: "Paris", day: "now" },
    });
  });

  it("turns a browse outcome into a goal-carrying client action", () => {
    const source = "open github and search for any pull requests in rivvl";
    const state = {
      utterance: source,
      currentProjectKey: null,
      focusedTaskKey: null,
      pendingRequest: "none" as const,
      continueContext: false,
    };
    const outcome = composeCirceOutcome({
      source,
      state,
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("browse") },
      tools: offered(),
      locationCandidates,
      websiteCandidates,
      work: () => workRefusal,
    });
    expect(outcome).toMatchObject({
      kind: "client-action",
      host: "client",
      tool: "browse",
      risk: "destructive",
      args: { goal: source },
      speech: "Working in your browser.",
    });
  });

  it("turns a preview outcome into a goal-carrying preview client action", () => {
    const source = "test the checkout flow against localhost";
    const state = {
      utterance: source,
      currentProjectKey: null,
      focusedTaskKey: null,
      pendingRequest: "none" as const,
      continueContext: false,
    };
    const outcome = composeCirceOutcome({
      source,
      state,
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("preview") },
      tools: offered(),
      locationCandidates,
      websiteCandidates,
      work: () => workRefusal,
    });
    expect(outcome).toMatchObject({
      kind: "client-action",
      host: "client",
      tool: "preview",
      risk: "destructive",
      args: { goal: source },
      speech: "Working in the preview browser.",
    });
  });

  it("resolves a client tool into a client-action with acceptance speech", () => {
    const outcome = composeCirceOutcome({
      source: "open YouTube",
      state: {
        utterance: "open YouTube",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("open-website"), "tool_open-website_website": choice("YouTube") },
      tools: offered(),
      websiteCandidates,
      work: () => workRefusal,
    });
    expect(outcome).toEqual({
      kind: "client-action",
      host: "client",
      tool: "open-website",
      risk: "mutating",
      args: { website: "YouTube" },
      speech: "Opening YouTube.",
    });
  });

  it("asks a typed lookup clarification when a required arg is missing", () => {
    const outcome = composeCirceOutcome({
      source: "what is the weather",
      state: {
        utterance: "what is the weather",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("weather"), tool_weather_day: choice("now") },
      tools: offered(),
      locationCandidates,
      websiteCandidates,
      work: () => workRefusal,
    });
    expect(outcome.kind).toBe("clarification");
    if (outcome.kind !== "clarification") return;
    expect(outcome.clarification.kind).toBe("lookup");
    if (outcome.clarification.kind !== "lookup") return;
    expect(outcome.clarification.tool).toBe("weather");
    expect(outcome.clarification.candidates).toEqual(locationCandidates);
  });

  it("returns a bounded inline conversation answer when one is supplied", () => {
    const outcome = composeCirceOutcome({
      source: "what is new today",
      state: {
        utterance: "what is new today",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("conversation") },
      tools: offered(),
      conversationAnswer: "Nothing yet.",
      work: () => workRefusal,
    });
    expect(outcome).toEqual({ kind: "conversation", answer: "Nothing yet." });
  });

  it("refuses rather than invent a conversation answer", () => {
    const outcome = composeCirceOutcome({
      source: "tell me about the world",
      state: {
        utterance: "tell me about the world",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("conversation") },
      tools: offered(),
      work: () => workRefusal,
    });
    expect(outcome).toEqual({ kind: "refused", reason: "classifier-declined" });
  });

  it("fails closed on a low-confidence selection", () => {
    const outcome = composeCirceOutcome({
      source: "mumble mumble",
      state: {
        utterance: "mumble mumble",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("work", 0.2) },
      tools: offered(),
      work: () => workRefusal,
    });
    expect(outcome).toEqual({ kind: "refused", reason: "confidence-too-low" });
  });

  it("hands work to the host resolver and returns its commands", () => {
    let seen: CirceSemanticProposal | undefined;
    const outcome = composeCirceOutcome({
      source: "what projects are there",
      state: {
        utterance: "what projects are there",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("work"), response_strategy: choice("list_report") },
      tools: offered(),
      work: (proposal) => {
        seen = proposal;
        return workRefusal;
      },
    });
    expect(seen?.action).toBe("list-projects");
    expect(outcome).toEqual({ kind: "work", commands: [{ type: "list-projects" }] });
  });

  it("maps a composed needs-input into a typed project clarification", () => {
    const commands: ReadonlyArray<CirceCommand> = [{ type: "list-projects" }];
    const outcome = composeCirceOutcome({
      source: "fix it",
      state: {
        utterance: "fix it",
        currentProjectKey: null,
        focusedTaskKey: null,
        pendingRequest: "none",
        continueContext: false,
      },
      table: { projects: [], tasks: [], providers: [], efforts: [] },
      boundaries: [],
      answers: { outcome: choice("work"), needs_clarification: { type: "noul", noul: 1 } },
      tools: offered(),
      work: () => ({ status: "commands", commands }),
    });
    expect(outcome).toEqual({
      kind: "clarification",
      clarification: { kind: "model", prompt: expect.any(String), choices: [] },
    });
  });
});

describe("proposal to outcome", () => {
  const tools = offered();
  const proposal = (input: Partial<CirceSemanticProposal>): CirceSemanticProposal => ({
    action: "start",
    refs: [],
    model: null,
    effort: null,
    answer: null,
    ...input,
  });

  it("maps a lookup proposal to a node tool answer", () => {
    const outcome = circeOutcomeFromProposal({
      proposal: proposal({
        action: "lookup",
        lookup: { kind: "weather", location: "Paris", day: "now" },
      }),
      tools,
    });
    expect(outcome).toEqual({
      kind: "tool-answer",
      host: "node",
      tool: "weather",
      risk: "read-only",
      args: { location: "Paris", day: "now" },
    });
  });

  it("maps a website proposal to a client action", () => {
    const outcome = circeOutcomeFromProposal({
      proposal: proposal({ action: "open-website", website: "YouTube" }),
      tools,
    });
    expect(outcome.kind).toBe("client-action");
    if (outcome.kind !== "client-action") return;
    expect(outcome.speech).toBe("Opening YouTube.");
  });

  it("maps a converse proposal to a bounded conversation", () => {
    const outcome = circeOutcomeFromProposal({
      proposal: proposal({ action: "converse", answer: "Nothing yet." }),
      tools,
    });
    expect(outcome).toEqual({ kind: "conversation", answer: "Nothing yet." });
  });

  it("maps unsupported to a refusal and never calls work", () => {
    const outcome = circeOutcomeFromProposal({
      proposal: proposal({ action: "unsupported" }),
      tools,
      work: () => {
        throw new Error("work must not run for unsupported");
      },
    });
    expect(outcome).toEqual({ kind: "refused", reason: "unsupported-command" });
  });

  it("delegates a work proposal to the host resolver with its commands", () => {
    const outcome = circeOutcomeFromProposal({
      proposal: proposal({ action: "list-projects" }),
      tools,
      work: () => ({ status: "commands", commands: [{ type: "list-projects" }] }),
    });
    expect(outcome).toEqual({ kind: "work", commands: [{ type: "list-projects" }] });
  });
});
