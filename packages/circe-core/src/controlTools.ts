/**
 * The bounded tool layer, declared once.
 *
 * Every deterministic assistant action is one `CirceTool`. A tool names its
 * execution host (`node` or `client`), the finite parameters a classifier may
 * fill, its risk, and the acceptance speech for a client action. It never
 * embeds an entry point.
 *
 * Execution lives on the host, keyed by the same tool name: node tools under
 * the server's node executor table, client tools under each client's action
 * table. A tool is offered to the classifier only when the host that will run
 * it advertises the capability, so the same intent resolves everywhere instead
 * of dying on whichever client lacks a hand-written shortcut.
 */

export type CirceToolHost = "node" | "client";

/** Risk gates the confidence floor a selection must clear and whether confirmation is layered on. */
export type CirceToolRisk = "read-only" | "mutating" | "destructive";

/**
 * Where the finite candidate set for a text parameter comes from. This is the
 * code-built side of classification: the model picks an element, never free
 * text, and the host re-checks the pick against the source utterance.
 */
export type CirceCandidateSource =
  | { readonly kind: "location" }
  | { readonly kind: "website" }
  | { readonly kind: "app" }
  | { readonly kind: "media-target" };

export type CirceToolParameter =
  | {
      readonly kind: "enum";
      readonly name: string;
      readonly values: ReadonlyArray<string>;
      readonly required: boolean;
    }
  | { readonly kind: "boolean"; readonly name: string; readonly required: boolean }
  | {
      readonly kind: "text";
      readonly name: string;
      readonly required: boolean;
      readonly candidates: CirceCandidateSource;
    };

export interface CirceTool {
  readonly name: string;
  readonly host: CirceToolHost;
  readonly description: string;
  readonly risk: CirceToolRisk;
  readonly parameters: ReadonlyArray<CirceToolParameter>;
  /**
   * Acceptance copy for a client action (the node cannot see the result) and
   * for a node tool before it runs. Node tools replace this with the real
   * result once execution finishes.
   */
  readonly renderAccepted: (args: CirceToolArguments) => string;
}

export type CirceToolArguments = Readonly<Record<string, string | boolean>>;

const p = {
  location: (required = true): CirceToolParameter => ({
    kind: "text",
    name: "location",
    required,
    candidates: { kind: "location" },
  }),
  day: (): CirceToolParameter => ({
    kind: "enum",
    name: "day",
    values: ["now", "today", "tomorrow"],
    required: true,
  }),
  website: (): CirceToolParameter => ({
    kind: "text",
    name: "website",
    required: true,
    candidates: { kind: "website" },
  }),
  app: (): CirceToolParameter => ({
    kind: "text",
    name: "app",
    required: true,
    candidates: { kind: "app" },
  }),
  mediaAction: (): CirceToolParameter => ({
    kind: "enum",
    name: "action",
    values: ["play", "pause", "next", "previous", "volume-up", "volume-down", "mute"],
    required: true,
  }),
  mediaTarget: (): CirceToolParameter => ({
    kind: "text",
    name: "target",
    required: false,
    candidates: { kind: "media-target" },
  }),
  clipboardAction: (): CirceToolParameter => ({
    kind: "enum",
    name: "action",
    values: ["copy", "paste"],
    required: true,
  }),
} as const;

/**
 * The tool catalog. Read-only lookups run on the node; anything that touches
 * the user's physical device is a client action so the origin client performs
 * it and can report a real result.
 */
export const CIRCE_TOOLS: ReadonlyArray<CirceTool> = [
  {
    name: "weather",
    host: "node",
    risk: "read-only",
    description: "Current or daily weather for a place the user named.",
    parameters: [p.location(), p.day()],
    renderAccepted: () => "Checking the weather.",
  },
  {
    name: "time",
    host: "node",
    risk: "read-only",
    description: "Current local time in a place the user named.",
    parameters: [p.location(), p.day()],
    renderAccepted: () => "Checking the time.",
  },
  {
    name: "task-status",
    host: "node",
    risk: "read-only",
    description: "Report the live state of one task.",
    parameters: [],
    renderAccepted: () => "Checking that task.",
  },
  {
    name: "list-projects",
    host: "node",
    risk: "read-only",
    description: "List the projects this node owns.",
    parameters: [],
    renderAccepted: () => "Listing your projects.",
  },
  {
    name: "open-website",
    host: "client",
    risk: "mutating",
    description: "Open an allowlisted site name or a web address the user spoke.",
    parameters: [p.website()],
    renderAccepted: (args) => `Opening ${String(args.website ?? "that site")}.`,
  },
  {
    name: "open-app",
    host: "client",
    risk: "mutating",
    description: "Launch a named application on the user's device.",
    parameters: [p.app()],
    renderAccepted: (args) => `Opening ${String(args.app ?? "that app")}.`,
  },
  {
    name: "media",
    host: "client",
    risk: "mutating",
    description: "Control media playback on the user's device.",
    parameters: [p.mediaAction(), p.mediaTarget()],
    renderAccepted: (args) => `${mediaVerb(String(args.action ?? ""))}.`,
  },
  {
    name: "clipboard",
    host: "client",
    risk: "mutating",
    description: "Read or write the device clipboard.",
    parameters: [p.clipboardAction()],
    renderAccepted: (args) => `${clEntity(args.action)} the clipboard.`,
  },
];

function mediaVerb(action: string): string {
  switch (action) {
    case "play":
      return "Playing";
    case "pause":
      return "Pausing";
    case "next":
      return "Skipping forward";
    case "previous":
      return "Skipping back";
    case "volume-up":
      return "Turning the volume up";
    case "volume-down":
      return "Turning the volume down";
    case "mute":
      return "Muting";
    default:
      return "Controlling media";
  }
}

function clEntity(action: string | boolean | undefined): string {
  return action === "copy" ? "Copying" : "Pasting";
}

export const findCirceTool = (name: string): CirceTool | undefined =>
  CIRCE_TOOLS.find((tool) => tool.name === name);

export const NONE_TOOL = "none";

/** Tools whose host can actually execute them right now. */
export function availableCirceTools(input: {
  readonly nodeTools: ReadonlyArray<string>;
  readonly clientTools: ReadonlyArray<string>;
}): ReadonlyArray<CirceTool> {
  const node = new Set(input.nodeTools);
  const client = new Set(input.clientTools);
  return CIRCE_TOOLS.filter((tool) =>
    tool.host === "node" ? node.has(tool.name) : client.has(tool.name),
  );
}

/** Closed choice question over the offered tools plus an explicit `none`. */
export function circeToolChoiceCriteria(
  tools: ReadonlyArray<CirceTool>,
): Readonly<Record<string, string>> {
  const criteria: Record<string, string> = {};
  for (const tool of tools) criteria[tool.name] = tool.description;
  criteria[NONE_TOOL] = "No bounded tool; this is work, conversation, or unclear.";
  return criteria;
}
