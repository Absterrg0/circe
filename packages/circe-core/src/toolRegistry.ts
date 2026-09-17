import type { DecisionChoiceQuestion, DecisionQuestion } from "./decision.ts";

/**
 * The deterministic tool layer. A tool is pure code selected by a finite
 * decision; it declares typed parameters, whether it mutates anything, its
 * origin, and a speech template. Weather and local time already need no model,
 * and the website launcher only accepts an allowlisted name or a spoken
 * address. Parameter values are never free text: enum parameters offer a
 * Choice over their values, booleans map to a Noul, and a text parameter gets
 * code-built candidates that the tool re-checks against the utterance.
 */

export type CirceToolParameterKind =
  | { readonly kind: "enum"; readonly name: string; readonly values: ReadonlyArray<string> }
  | { readonly kind: "boolean"; readonly name: string }
  | { readonly kind: "text"; readonly name: string; readonly optional?: boolean };

export interface CirceTool {
  readonly name: string;
  /** The proposal action this tool resolves to. */
  readonly action: "lookup" | "open-website" | "status" | "list-projects";
  readonly description: string;
  readonly readOnly: boolean;
  readonly origin: "host" | "client";
  readonly speechTemplate: string;
  readonly parameters: ReadonlyArray<CirceToolParameterKind>;
}

export const CIRCE_TOOLS: ReadonlyArray<CirceTool> = [
  {
    name: "weather",
    action: "lookup",
    description: "Current or daily weather for a place the user named.",
    readOnly: true,
    origin: "host",
    speechTemplate: "{label}: {conditions}",
    parameters: [
      { kind: "text", name: "location" },
      { kind: "enum", name: "day", values: ["now", "today", "tomorrow"] },
    ],
  },
  {
    name: "time",
    action: "lookup",
    description: "Current local time in a place the user named.",
    readOnly: true,
    origin: "host",
    speechTemplate: "{label}: {time}",
    parameters: [
      { kind: "text", name: "location" },
      { kind: "enum", name: "day", values: ["now", "today", "tomorrow"] },
    ],
  },
  {
    name: "open-website",
    action: "open-website",
    description: "Open an allowlisted site name or a web address the user spoke.",
    readOnly: false,
    origin: "client",
    speechTemplate: "Opening {website}.",
    parameters: [{ kind: "text", name: "website" }],
  },
  {
    name: "task-status",
    action: "status",
    description: "Report the live state of one task.",
    readOnly: true,
    origin: "host",
    speechTemplate: "{status}",
    parameters: [],
  },
  {
    name: "list-projects",
    action: "list-projects",
    description: "List the projects this node owns.",
    readOnly: true,
    origin: "host",
    speechTemplate: "Listing your projects.",
    parameters: [],
  },
];

export const NONE_OPTION = "none";

export const findCirceTool = (name: string): CirceTool | undefined =>
  CIRCE_TOOLS.find((tool) => tool.name === name);

/** Choice question over every registered tool plus an explicit `none`. */
export function buildToolChoiceQuestion(): DecisionChoiceQuestion {
  const criteria: Record<string, string | null> = {};
  for (const tool of CIRCE_TOOLS) criteria[tool.name] = tool.description;
  criteria[NONE_OPTION] = "No tool; this is project or task work, or conversation.";
  return {
    type: "choice",
    instructions: "Which bounded assistant tool does this request need, if any?",
    criteria,
  };
}

/**
 * Per-tool argument questions. Enum parameters become a Choice over their
 * values; text parameters become a Choice over code-built candidates; a text
 * parameter with no candidate is omitted so the tool can act on the whole
 * utterance or decline. Every Choice carries `none` so the set stays closed.
 */
export function buildToolArgumentQuestions(
  tool: CirceTool,
  candidates: {
    readonly location?: ReadonlyArray<string>;
    readonly website?: ReadonlyArray<string>;
  },
): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const parameter of tool.parameters) {
    const id = `tool_${tool.name}_${parameter.name}`;
    if (parameter.kind === "enum") {
      const criteria: Record<string, string | null> = {};
      for (const value of parameter.values) criteria[value] = null;
      criteria[NONE_OPTION] = "Not specified.";
      questions[id] = {
        type: "choice",
        instructions: `Which ${parameter.name} did the user ask for?`,
        criteria,
      };
      continue;
    }
    if (parameter.kind === "boolean") {
      questions[id] = {
        type: "noul",
        instructions: `Is the ${parameter.name} parameter present in the request?`,
        criteria: { true: `${parameter.name} is given.`, false: `${parameter.name} is omitted.` },
      };
      continue;
    }
    const values =
      parameter.name === "location"
        ? (candidates.location ?? [])
        : parameter.name === "website"
          ? (candidates.website ?? [])
          : [];
    if (values.length === 0) continue;
    const criteria: Record<string, string | null> = {};
    for (const value of values) criteria[value] = null;
    criteria[NONE_OPTION] = "Not specified.";
    questions[id] = {
      type: "choice",
      instructions: `Which ${parameter.name} did the user name?`,
      criteria,
    };
  }
  return questions;
}
