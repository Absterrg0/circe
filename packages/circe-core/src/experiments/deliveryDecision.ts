import {
  choiceAnswer,
  noulHolds,
  type DecisionAnswers,
  type DecisionRequest,
} from "../decision.ts";

/**
 * Experiment: one finite decision for "what should Circe do with this result?"
 *
 * Today the answer is fixed: reports speak by default (one global boolean) and
 * push fires to every active token regardless of whether the user is staring
 * at the thread. That is why spoken reports feel random and phones buzz for
 * work already on screen.
 *
 * This decides a channel and a timing from typed attention state, then code
 * enforces the inviolable rules. The model never invents a channel or a
 * message; the message already exists in the presentation event.
 */

export type CirceDeliveryChannel = "speak" | "push" | "badge" | "silent";
export type CirceDeliveryTiming = "now" | "queue" | "hold";

export interface DeliveryAttention {
  readonly appState: "active" | "inactive" | "background" | "unknown";
  readonly visible: boolean;
  readonly focused: boolean;
  readonly recentlyInteracted: boolean;
  readonly voiceEnabled: boolean;
  readonly liveSessionActive: boolean;
  readonly alreadySpeaking: boolean;
}

export interface DeliveryOutcome {
  readonly kind: "completed" | "failed" | "approval-needed" | "waiting-for-input";
  readonly threadRelation: "focused" | "other-thread" | "unfocused";
  /** The user must act before the task can continue. */
  readonly actionable: boolean;
  /** A destructive approval or an unrecoverable failure. */
  readonly urgent: boolean;
}

const CHANNELS = new Set<CirceDeliveryChannel>(["speak", "push", "badge", "silent"]);
const TIMINGS = new Set<CirceDeliveryTiming>(["now", "queue", "hold"]);

const choice = (
  instructions: string,
  criteria: Record<string, string | null>,
): DecisionRequest["questions"][string] => ({ type: "choice", instructions, criteria });

const noul = (instructions: string, yes: string, no: string) => ({
  type: "noul" as const,
  instructions,
  criteria: { true: yes, false: no },
});

export function buildDeliveryDecisionRequest(input: {
  readonly outcome: DeliveryOutcome;
  readonly attention: DeliveryAttention;
}): DecisionRequest {
  const channelCriteria: Record<string, string | null> = {
    speak: "Voice the result now through the active speech lane.",
    push: "Send a notification the user can act on later.",
    badge: "Update an unread badge only; no interruption.",
    silent: "The user has already seen it; do nothing.",
  };
  const timingCriteria: Record<string, string | null> = {
    now: "Deliver immediately.",
    queue: "Hold until the user is idle or the current speech ends.",
    hold: "Wait for a better moment; deliver at most once.",
  };
  return {
    state: {
      outcome: input.outcome,
      attention: input.attention,
      rules: [
        "A user who is looking at the same thread has already seen the result.",
        "Never interrupt speech; queue instead.",
        "A background app cannot be spoken to.",
      ],
    },
    model: "jev-latest",
    questions: {
      channel: choice(
        "What is the least disruptive channel that still reaches the user?",
        channelCriteria,
      ),
      timing: choice("When should it be delivered?", timingCriteria),
      user_is_attending: noul(
        "Is the user actively paying attention to Circe right now?",
        "Visible, focused, or recently interacting.",
        "Backgrounded, locked, or away.",
      ),
      same_thread: noul(
        "Is the user already looking at the exact thread this result belongs to?",
        "The thread is focused.",
        "A different or no thread is focused.",
      ),
      work_is_finished: noul(
        "Could the user now safely ignore this for a while?",
        "Nothing is blocked on the user.",
        "The user must act before work continues.",
      ),
    },
  };
}

export interface DeliveryPlan {
  readonly channel: CirceDeliveryChannel;
  readonly timing: CirceDeliveryTiming;
  readonly reason: string;
}

const attending = (attention: DeliveryAttention): boolean =>
  attention.visible && (attention.focused || attention.recentlyInteracted);

/**
 * Code owns the inviolable rules, so a wrong selection can never wake a
 * backgrounded user or drop something that actually needs them:
 * - actionable outcomes always reach the user (push at minimum, speech when
 *   attended);
 * - never speak while speech is active (queue), and never speak from the
 *   background (push instead);
 * - a completed result already focused on its own thread is silent.
 */
export function composeDeliveryPlan(input: {
  readonly outcome: DeliveryOutcome;
  readonly attention: DeliveryAttention;
  readonly answers: DecisionAnswers;
}): DeliveryPlan {
  const { outcome, attention, answers } = input;
  const selectedChannel = choiceAnswer(answers, "channel")?.choice as
    | CirceDeliveryChannel
    | undefined;
  const selectedTiming = choiceAnswer(answers, "timing")?.choice as CirceDeliveryTiming | undefined;
  const proposed =
    selectedChannel !== undefined && CHANNELS.has(selectedChannel) ? selectedChannel : "push";
  const timing =
    selectedTiming !== undefined && TIMINGS.has(selectedTiming) ? selectedTiming : "now";

  const modelAttending = noulHolds(answers, "user_is_attending", 0.5) ?? attending(attention);
  const sameThread = noulHolds(answers, "same_thread", 0.5) ?? false;

  const canSpeak =
    attention.voiceEnabled &&
    attention.appState === "active" &&
    modelAttending &&
    !attention.alreadySpeaking;

  if (outcome.actionable) {
    if (canSpeak && (sameThread || outcome.urgent)) {
      return {
        channel: "speak",
        timing: attention.alreadySpeaking ? "queue" : "now",
        reason: "Actionable and the user is here.",
      };
    }
    return {
      channel: "push",
      timing: attention.alreadySpeaking ? "queue" : "now",
      reason: "Actionable but the user is away.",
    };
  }

  if (sameThread && attention.visible) {
    return {
      channel: "silent",
      timing: "now",
      reason: "The user is already looking at the result.",
    };
  }
  if (attention.alreadySpeaking) {
    return {
      channel: proposed === "speak" ? "push" : proposed,
      timing: "queue",
      reason: "Speech is busy; do not interrupt.",
    };
  }
  if (!attending(attention)) {
    return {
      channel: proposed === "speak" || proposed === "silent" ? "push" : proposed,
      timing: "now",
      reason: "The user is away.",
    };
  }
  if (proposed === "speak" && !canSpeak) {
    return { channel: "badge", timing: "now", reason: "Speech is not available here." };
  }
  return { channel: proposed, timing, reason: "Classifier choice." };
}
