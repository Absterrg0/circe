import { assert, describe, it } from "@effect/vitest";

import {
  CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS,
  NO_CIRCE_TOOLS,
  circeToolAvailability,
  circeToolInstructions,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./T3OrchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<circe_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
  });

  it("gives ACP sessions provider-neutral mode, browser, desktop, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: {
        interactionMode: "default",
        hasT3Mcp: true,
        tools: { browser: true, desktop: true },
      },
    });

    assert.include(injected, "Circe interaction mode: Default");
    assert.include(injected, "Circe browsers");
    assert.include(injected, "Circe desktop");
    assert.include(injected, "Circe orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = {
      interactionMode: "default",
      hasT3Mcp: true,
      tools: { browser: true, desktop: true },
    } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Circe interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false, tools: NO_CIRCE_TOOLS },
    });
    assert.include(withoutMcp, "Circe interaction mode: Default");
    assert.notInclude(withoutMcp, "Circe browsers");
    assert.notInclude(withoutMcp, "Circe desktop");
    assert.notInclude(withoutMcp, "Circe orchestration");
    // Losing the computer mid-session is a change the agent is told about.
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, tools: { browser: true, desktop: false } },
        previousState: defaultState,
      }),
      "Circe orchestration",
    );
  });

  it("describes exactly the tools a session has, for every provider channel", () => {
    const desktopOnly = { browser: false, desktop: true };
    for (const text of [
      circeToolInstructions(desktopOnly),
      t3OrchestrationSystemPrompt(true, desktopOnly) ?? "",
      t3OrchestrationPromptForFirstRun({
        prompt: "Check it.",
        runOrdinal: 1,
        hasT3Mcp: true,
        tools: desktopOnly,
      }),
    ]) {
      assert.include(text, "computer_begin");
      assert.notInclude(text, "Circe browsers");
      assert.include(text, "Circe orchestration");
    }
    assert.notInclude(circeToolInstructions(NO_CIRCE_TOOLS), "computer_begin");
    assert.deepStrictEqual(
      circeToolAvailability({
        browserToolsAvailable: false,
        capabilities: new Set(["computer-use"]),
      }),
      desktopOnly,
    );
    assert.deepStrictEqual(circeToolAvailability(undefined), NO_CIRCE_TOOLS);
  });
});
