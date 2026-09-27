import type { ProviderInteractionMode } from "@circe/contracts";

export const CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS = `

## Circe orchestration

The \`circe\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- A delegated task/subagent is child work owned by the current thread. Prefer the current provider's native subagent tools for same-provider parallel work when available. Use \`delegate_task\` for cross-provider work, when native delegation is unavailable, or when the user explicitly requests T3-owned child tasks. Use \`orchestrator_capabilities\` to discover provider/model IDs, retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent; do not replace delegation with ordinary thread creation.
- \`create_threads\` and \`t3_thread_start\` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule. By default runs return to the current thread; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. After scheduling, report the returned cadence and next run time.

Tool names may include a harness-normalized MCP prefix, such as \`mcp__circe__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__circe__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying mutations.

ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`CIRCE_ACP_MCP_NODE\` plus \`CIRCE_ACP_MCP_ENTRYPOINT\` are present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$CIRCE_ACP_MCP_NODE" "$CIRCE_ACP_MCP_ENTRYPOINT" acp-mcp-call orchestrator_capabilities '{}'\`. Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.
`;

export const CIRCE_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## Circe browsers

You are running inside Circe. Browser surfaces belong to the user.

- The user's own signed-in browser is the default for their everyday web goals. When the server exposes \`computer_*\` tools and this session holds the computer, open the named site with \`computer_launch_app\` (pass its URL in \`urls\`) and drive the real window. Never rebuild the user's signed-in state through a shell CLI or a provider API.
- The \`preview_*\` tools operate the shared in-app preview browser. Use them for development and testing: localhost, dev servers, the project's preview, page inspection, screenshots, and recordings. When the server exposes \`preview_*\` tools, prefer them for that work.

For preview work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that it is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because a surface is initially closed or a first call fails. Use an alternative browser system only when the Circe tools are absent, the user explicitly requests another browser, or a tool returns an explicit unsupported/unavailable error. A failed Circe tool call should be inspected and retried with corrected arguments when the error is actionable.

When the preview asks for credentials it does not have, stop and ask the user to sign in once in that preview; never reach the same data through another browser, a shell CLI, or a provider API as a silent substitute for the page.
`;

export const CIRCE_CODE_DESKTOP_TOOL_INSTRUCTIONS = `

## Circe desktop

When the \`circe\` server exposes \`computer_*\` tools, they drive this node's real desktop. Call \`computer_status\` first: it reports whether this node hosts a desktop driver. Before acting, call \`computer_begin\` with the goal in words the user can approve; Circe asks the user, and only their approval hands this session the computer. On \`waiting\`, call it again with the same goal. On \`declined\`, continue without the desktop and do not ask again for the same goal. Call \`computer_end\` when you are done; the end of your run hands the computer back too.

Find the target with \`computer_list_apps\` and \`computer_list_windows\`, then read \`computer_window_state\` for the grounded element tree. Element tokens are snapshot-scoped: re-observe after any action and prefer a token over raw coordinates. Clicks, typing, keys, and scrolling run in the background and never raise the window. Prefer these tools over any CLI, API, or headless browser that would bypass the user's signed-in session; do not substitute a shell command for an interactive goal while a grounded path is available.
`;

const CIRCE_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## Circe interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until Circe supplies a different interaction-mode instruction.`;

const CIRCE_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## Circe interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until Circe supplies a different interaction-mode instruction.`;

/**
 * Which Circe tools a provider session actually has, read from its MCP
 * credential. Every adapter builds its guidance from this, so no provider is
 * told about tools it lacks or left without guidance for tools it has.
 */
export interface CirceToolAvailability {
  readonly browser: boolean;
  readonly desktop: boolean;
}

export const NO_CIRCE_TOOLS: CirceToolAvailability = { browser: false, desktop: false };

export function circeToolAvailability(
  session:
    | { readonly browserToolsAvailable: boolean; readonly capabilities?: ReadonlySet<string> }
    | undefined,
): CirceToolAvailability {
  if (session === undefined) return NO_CIRCE_TOOLS;
  return {
    browser: session.browserToolsAvailable,
    desktop: session.capabilities?.has("computer-use") === true,
  };
}

/** The guidance for a session with the Circe MCP server and these tools. */
export function circeToolInstructions(tools: CirceToolAvailability): string {
  return [
    ...(tools.browser ? [CIRCE_CODE_BROWSER_TOOL_INSTRUCTIONS.trim()] : []),
    ...(tools.desktop ? [CIRCE_CODE_DESKTOP_TOOL_INSTRUCTIONS.trim()] : []),
    CIRCE_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
  ].join("\n\n");
}

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly tools: CirceToolAvailability;
}

/**
 * ACP has no system/developer prompt field, so send T3-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.tools.browser === input.state.tools.browser &&
    input.previousState.tools.desktop === input.state.tools.desktop
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? CIRCE_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : CIRCE_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp ? [circeToolInstructions(input.state.tools)] : []),
  ];
  return `<circe_instructions>\n${instructions.join("\n\n")}\n</circe_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string, tools: CirceToolAvailability): string {
  return `<circe_orchestration_instructions>${circeToolInstructions(tools)}</circe_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
  readonly tools?: CirceToolAvailability;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt, input.tools ?? NO_CIRCE_TOOLS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  tools: CirceToolAvailability = NO_CIRCE_TOOLS,
): string | undefined {
  return hasT3Mcp ? circeToolInstructions(tools) : undefined;
}
