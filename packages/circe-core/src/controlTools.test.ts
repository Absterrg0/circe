import { describe, expect, it } from "vite-plus/test";

import {
  CIRCE_TOOLS,
  NONE_TOOL,
  availableCirceTools,
  circeToolChoiceCriteria,
  findCirceTool,
} from "./controlTools.ts";
import { circeOutcomeHost, circeOutcomeIsCompound } from "./controlOutcome.ts";

describe("the bounded tool catalog", () => {
  it("declares every tool name once", () => {
    const names = CIRCE_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("separates node tools from client tools", () => {
    const node = CIRCE_TOOLS.filter((tool) => tool.host === "node").map((tool) => tool.name);
    const client = CIRCE_TOOLS.filter((tool) => tool.host === "client").map((tool) => tool.name);
    expect(node).toEqual(["weather", "time", "task-status", "list-projects"]);
    expect(client).toEqual([
      "open-website",
      "open-app",
      "media",
      "clipboard",
      "computer",
    ]);
  });

  it("offers only tools whose host advertised the capability", () => {
    // Regression: a Controller client used to be routed to and then refuse the
    // work. The classifier must simply never see a tool the host cannot run.
    const offered = availableCirceTools({ nodeTools: ["weather"], clientTools: ["open-website"] });
    expect(offered.map((tool) => tool.name)).toEqual(["weather", "open-website"]);
    expect(findCirceTool("computer")).toBeDefined();
    expect(offered.find((tool) => tool.name === "computer")).toBeUndefined();
  });

  it("keeps the tool choice closed with an explicit none", () => {
    const criteria = circeToolChoiceCriteria(availableCirceTools({
      nodeTools: ["weather", "time", "task-status", "list-projects"],
      clientTools: ["open-website"],
    }));
    expect(Object.keys(criteria)).toContain(NONE_TOOL);
    expect(criteria[NONE_TOOL]).toBeTruthy();
    for (const key of Object.keys(criteria)) expect(criteria[key]).toBeTruthy();
  });

  it("renders acceptance speech for every tool", () => {
    for (const tool of CIRCE_TOOLS) {
      const args = Object.fromEntries(
        tool.parameters
          .filter((parameter) => parameter.kind !== "boolean")
          .map((parameter) =>
            parameter.kind === "enum"
              ? [parameter.name, parameter.values[0]!]
              : [parameter.name, "thing"],
          ),
      );
      expect(tool.renderAccepted(args).trim().length, tool.name).toBeGreaterThan(0);
    }
  });
});

describe("first-class outcomes", () => {
  it("treats only multi-command work as compound", () => {
    expect(circeOutcomeIsCompound({ kind: "work", commands: [{ type: "list-projects" }] })).toBe(
      false,
    );
    expect(
      circeOutcomeIsCompound({
        kind: "work",
        commands: [{ type: "list-projects" }, { type: "list-projects" }],
      }),
    ).toBe(true);
    expect(circeOutcomeIsCompound({ kind: "conversation", answer: "hi" })).toBe(false);
  });

  it("reports the executing host only for tool outcomes", () => {
    expect(
      circeOutcomeHost({
        kind: "tool-answer",
        host: "node",
        tool: "weather",
        risk: "read-only",
        args: {},
      }),
    ).toBe("node");
    expect(
      circeOutcomeHost({
        kind: "client-action",
        host: "client",
        tool: "open-website",
        risk: "mutating",
        args: {},
        speech: "Opening it.",
      }),
    ).toBe("client");
    expect(circeOutcomeHost({ kind: "conversation", answer: "hi" })).toBeNull();
  });
});
