import type { CirceCommand } from "./command.ts";
import type { CirceToolArguments, CirceToolHost, CirceToolRisk } from "./controlTools.ts";

/**
 * What one classified turn resolves to. These are the only shapes the
 * dispatcher understands, and each is produced by exactly one owner:
 *
 * - work          code-authorized commands handed to the T3 engine
 * - tool-answer   a node tool the node executes and speaks
 * - client-action a typed action the origin client performs and speaks
 * - clarification a durable pending frame the user answers on any client
 * - conversation  a bounded inline answer, no task and no thread
 * - refused       fail-closed: the classifier declined or the request is out of scope
 *
 * `converse` no longer appears here. Asking a general question is a
 * conversation; running a bounded lookup is a tool answer; neither pretends
 * to be the other.
 */
export type CirceOutcome =
  | {
      readonly kind: "work";
      /** Ordered commands. More than one when the turn is compound. */
      readonly commands: ReadonlyArray<CirceCommand>;
    }
  | {
      readonly kind: "tool-answer";
      readonly host: "node";
      readonly tool: string;
      readonly risk: CirceToolRisk;
      readonly args: CirceToolArguments;
    }
  | {
      readonly kind: "client-action";
      readonly host: "client";
      readonly tool: string;
      readonly risk: CirceToolRisk;
      readonly args: CirceToolArguments;
      /** Determined at classification time so the node can speak acceptance. */
      readonly speech: string;
    }
  | {
      readonly kind: "conversation";
      /** Bounded, spoken-sized answer. */
      readonly answer: string;
    }
  | { readonly kind: "clarification"; readonly clarification: CirceClarification }
  | { readonly kind: "refused"; readonly reason: CirceRefusalReason };

export type CirceRefusalReason =
  | "classifier-declined"
  | "classifier-unavailable"
  | "unsupported-command"
  | "confidence-too-low";

/**
 * Every clarification kind is typed and durable. A frame carries everything
 * needed to resume the original turn, so the answer may arrive on a different
 * client than the one that started it.
 *
 * `lookup` and `website` are the kinds the old system left untyped: the user
 * could not refine a place or a site without restating the whole turn.
 */
export type CirceClarification =
  | {
      readonly kind: "project";
      readonly prompt: string;
      readonly candidates: ReadonlyArray<{
        readonly projectId: string;
        readonly nodeId?: string;
        readonly label: string;
      }>;
    }
  | {
      readonly kind: "task";
      readonly prompt: string;
      readonly candidates: ReadonlyArray<{ readonly threadId: string; readonly label: string }>;
    }
  | {
      readonly kind: "model";
      readonly prompt: string;
      readonly choices: ReadonlyArray<string>;
    }
  | {
      readonly kind: "lookup";
      readonly prompt: string;
      readonly tool: "weather" | "time";
      readonly candidates: ReadonlyArray<string>;
      /** The lookup a refinement continues, when the user is narrowing a prior ask. */
      readonly previous?: { readonly location: string; readonly day: "now" | "today" | "tomorrow" };
    }
  | {
      readonly kind: "website";
      readonly prompt: string;
      readonly candidates: ReadonlyArray<string>;
    }
  | {
      readonly kind: "confirm";
      readonly prompt: string;
      readonly risk: "destructive";
    };

export type CirceClarificationKind = CirceClarification["kind"];

/** True when the turn carries more than one independent command. */
export const circeOutcomeIsCompound = (outcome: CirceOutcome): boolean =>
  outcome.kind === "work" && outcome.commands.length > 1;

/** Host that owns execution of an outcome, or null when no host executes directly. */
export const circeOutcomeHost = (outcome: CirceOutcome): CirceToolHost | null => {
  if (outcome.kind === "tool-answer" || outcome.kind === "client-action") return outcome.host;
  return null;
};
