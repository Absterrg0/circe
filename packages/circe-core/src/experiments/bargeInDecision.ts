import {
  choiceAnswer,
  noulHolds,
  type DecisionAnswers,
  type DecisionRequest,
} from "../decision.ts";

/**
 * Experiment: classify speech that lands while Circe is already working.
 *
 * Live voice currently trusts the model's own interruption policy and a regex
 * over the last 400 characters to decide whether an utterance was real. That
 * is why backchannels ("mm-hm", "okay") sometimes cancel work and corrections
 * sometimes get ignored. This makes the decision finite and explicit before
 * anything reaches the interpreter.
 */

export type BargeInIntent = "command" | "correction" | "stop" | "answer" | "backchannel" | "ignore";

export interface BargeInContext {
  readonly transcript: string;
  readonly assistantSpeaking: boolean;
  readonly taskRunning: boolean;
  readonly hasPendingRequest: boolean;
  /** A request from this same utterance is already in flight. */
  readonly priorRequestActive: boolean;
}

export const BARGE_IN_INTENTS: ReadonlyArray<BargeInIntent> = [
  "command",
  "correction",
  "stop",
  "answer",
  "backchannel",
  "ignore",
];

const CRITERIA: Readonly<Record<BargeInIntent, string>> = {
  command: "A new instruction for the running work.",
  correction: "Repairs a previous instruction ('no, I meant', 'actually').",
  stop: "Cancels the running work ('stop', 'never mind').",
  answer: "Answers the pending question or approval.",
  backchannel: "Acknowledgement only ('mm-hm', 'okay', 'right').",
  ignore: "Not addressed to Circe ('hey Sam, look at this').",
};

const choice = (
  instructions: string,
  criteria: Record<string, string | null>,
): DecisionRequest["questions"][string] => ({ type: "choice", instructions, criteria });

const noul = (instructions: string, yes: string, no: string) => ({
  type: "noul" as const,
  instructions,
  criteria: { true: yes, false: no },
});

export function buildBargeInDecisionRequest(input: {
  readonly context: BargeInContext;
}): DecisionRequest {
  const criteria: Record<string, string | null> = {};
  for (const intent of BARGE_IN_INTENTS) criteria[intent] = CRITERIA[intent];
  return {
    state: {
      transcript: input.context.transcript,
      assistantSpeaking: input.context.assistantSpeaking,
      taskRunning: input.context.taskRunning,
      pendingRequest: input.context.hasPendingRequest,
    },
    model: "jev-latest",
    questions: {
      intent: choice("What did the user just do?", criteria),
      addressed_to_circe: noul(
        "Was this spoken to Circe?",
        "It addresses the assistant.",
        "It addresses someone else or nobody.",
      ),
      is_backchannel_only: noul(
        "Is this an acknowledgement with no request in it?",
        "It carries no instruction.",
        "It asks for something.",
      ),
      cancels_prior: noul(
        "Does this cancel the work already running or requested?",
        "It cancels or replaces the current work.",
        "It leaves the current work in place.",
      ),
    },
  };
}

export type BargeInAction =
  | { readonly status: "interrupt"; readonly intent: BargeInIntent; readonly reason: string }
  | { readonly status: "route"; readonly intent: BargeInIntent; readonly reason: string }
  | { readonly status: "queue"; readonly intent: BargeInIntent; readonly reason: string }
  | { readonly status: "ignore"; readonly intent: BargeInIntent; readonly reason: string };

const CONFIDENT = 0.6;

/**
 * Code decides the consequence, never the model:
 * - stop and correction always interrupt;
 * - an answer routes to the pending request;
 * - a command routes only when it addresses Circe and is not backchannel,
 *   otherwise it queues while work runs and is ignored while Circe speaks;
 * - backchannel and off-target speech never interrupt.
 */
export function composeBargeInAction(input: {
  readonly context: BargeInContext;
  readonly answers: DecisionAnswers;
}): BargeInAction {
  const { context, answers } = input;
  const intentAnswer = choiceAnswer(answers, "intent");
  const intent =
    intentAnswer !== undefined && intentAnswer.confidence >= CONFIDENT
      ? (intentAnswer.choice as BargeInIntent)
      : undefined;

  if (intent === "stop" || intent === "correction") {
    return { status: "interrupt", intent, reason: "The user is redirecting or cancelling." };
  }
  if (intent === "answer") {
    return context.hasPendingRequest
      ? { status: "route", intent, reason: "It answers the waiting request." }
      : { status: "ignore", intent, reason: "Nothing is waiting for an answer." };
  }

  const backchannel = noulHolds(answers, "is_backchannel_only", 0.5) ?? intent === "backchannel";
  const addressed = noulHolds(answers, "addressed_to_circe", 0.5) ?? false;

  if (intent === "backchannel" || intent === "ignore" || backchannel) {
    return { status: "ignore", intent: intent ?? "backchannel", reason: "No request in it." };
  }
  if (intent === undefined) {
    // Uncertain during speech is a backchannel until proven otherwise; while
    // work runs, never interrupt on an uncertain utterance.
    return context.assistantSpeaking
      ? { status: "ignore", intent: "backchannel", reason: "Uncertain speech during playback." }
      : { status: "route", intent: "command", reason: "Uncertain but the floor is free." };
  }
  if (intent === "command") {
    if (!addressed) return { status: "ignore", intent, reason: "Not addressed to Circe." };
    if (context.assistantSpeaking) {
      return { status: "queue", intent, reason: "Do not interrupt speech." };
    }
    return { status: "route", intent, reason: "Circe should act on it." };
  }
  return { status: "ignore", intent, reason: "Nothing to do." };
}
