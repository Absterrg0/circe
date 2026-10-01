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

When the \`circe\` server exposes \`computer_*\` tools, they drive this node's real desktop. For a goal on the desktop, call \`computer_do\` once with the whole goal in the user's words: Circe asks the user for the computer, opens or reuses the app, finds and chooses each control on screen, acts, and checks the result itself. When you already know the steps, pass them as \`plan\` (for "12 times 7 in Calculator": fill the text box with 12*7, click the = button, done when it shows 84); name controls as the app shows them and never guess ids. Enter an entire text or expression with one fill of a text box, using its role alone when unnamed. Never assemble text or numbers by clicking individual character buttons. Expected screen values must be literal values, not prose descriptions. On \`waiting\`, call it again with the same goal. On \`declined\`, continue without the desktop and do not ask again for the same goal. Only \`done\` means the screen showed the result; report any other status and its message as it is, and do not claim success. Treat \`unverified\`, \`uncertain\`, \`failed\` and \`stopped\` as terminal results. Report the message accurately, call \`computer_end\`, and do not retry through step tools or claim success from text that only echoes your input.

Use the step tools below only when \`computer_do\` is unavailable, or when the user asks you to drive the desktop yourself. Call \`computer_status\` first: it reports whether this node hosts a desktop driver. Before acting, call \`computer_begin\` with the goal in words the user can approve; Circe asks the user, and only their approval hands this session the computer. Call \`computer_end\` when you are done; the end of your run hands the computer back too.

Reuse an open target with \`computer_list_windows\`; for a closed app use \`computer_list_apps\` with a narrow query, then launch its launchPath. An app can restore a prior document when launched, so launch does not mean the document is new or blank. If the user asks for a new, blank, or unsaved document, inspect the live window, use an observed New/Create control when needed, and confirm the editor is empty or visibly identifies a new document before filling it. Never replace text in a nonempty existing document to satisfy a request for a new one. Use the returned launch windows directly, then read \`computer_window_state\` for the controls you can act on and pass a \`controlId\` to click or type. Click and type return a fresh windowState with new controlIds: use those directly for the next action. If windowState is absent, observe again before acting. Every older controlId is retired. When a window draws its own controls, the observation also lists text and controls read from the screen (source visual, click only); ask for them with \`lookCloser\` if the accessible controls lack what you need. There is no coordinate click. Native control input and scrolling use background delivery. Type a complete expression or text in one call using the native text field's controlId, instead of clicking each character. For submit, equals, and other button actions, click the native button in the returned windowState instead of pressing a key. Typing with only a window identity cannot target a native text field in the background. For a drawn field that cannot receive background typing, report the limitation and request foreground work only if it is needed. All actions default to background delivery, including visual clicks. If background delivery is unavailable, report the limitation. Use foreground delivery only when the user explicitly asks to bring the target forward. Reuse the existing app window unless the user asks for a new one. An effect of dispatched-unknown means the action was sent, not that it failed: observe its result before deciding what to do next. If launch returns no window, check windows once and report the limitation; do not repeatedly relaunch or troubleshoot the desktop through shell commands. Prefer these tools over any CLI, API, or headless browser that would bypass the user's signed-in session; do not substitute a shell command for an interactive goal while a grounded path is available.
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
