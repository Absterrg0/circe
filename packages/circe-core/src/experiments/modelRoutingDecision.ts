import {
  choiceAnswer,
  noulHolds,
  type DecisionAnswers,
  type DecisionRequest,
} from "../decision.ts";
import { NONE_OPTION } from "../toolRegistry.ts";

/**
 * Experiment: route work by stated intent, not by array order.
 *
 * Today an unnamed request takes the first usable provider and its default
 * model (`firstAvailableModelSelection`), effort is silently defaulted to the
 * descriptor low, and a local-model "cheap" pick is a regex over slugs. The
 * user's actual priority ("cheap", "fast", "best") is never represented.
 *
 * Here the model selects a priority and a reasoning-heavy predicate from
 * closed sets, and code ranks the real catalog. Cost and speed ranks are
 * host-supplied (from the usage rate table and provider metadata), so the
 * model never guesses a price.
 */

export type RoutingPriority = "cheap" | "fast" | "best" | "default";

export interface ModelRouteCandidate {
  readonly provider: string;
  readonly model: string;
  readonly key: string;
  readonly isDefault?: boolean;
  /** Normalized 0..1 within the catalog; lower is cheaper/faster, higher better. */
  readonly costRank?: number;
  readonly speedRank?: number;
  readonly qualityRank?: number;
}

export const ROUTING_PRIORITIES: ReadonlyArray<RoutingPriority> = [
  "cheap",
  "fast",
  "best",
  "default",
];

const PRIORITY_CRITERIA: Readonly<Record<RoutingPriority, string>> = {
  cheap: "Minimize token spend.",
  fast: "Minimize latency.",
  best: "Maximize capability, cost is not the concern.",
  default: "No priority stated; use the configured default.",
};

const choice = (
  instructions: string,
  criteria: Record<string, string | null>,
): DecisionRequest["questions"][string] => ({ type: "choice", instructions, criteria });

export function buildRoutingDecisionRequest(input: {
  readonly candidates: ReadonlyArray<ModelRouteCandidate>;
  readonly requestedModel?: string;
}): DecisionRequest {
  const modelCriteria: Record<string, string | null> = {};
  for (const candidate of input.candidates) {
    modelCriteria[candidate.key] = [
      candidate.model,
      candidate.isDefault === true ? "default" : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join(", ");
  }
  modelCriteria[NONE_OPTION] = "No specific model was named.";

  const priorityCriteria: Record<string, string | null> = {};
  for (const priority of ROUTING_PRIORITIES)
    priorityCriteria[priority] = PRIORITY_CRITERIA[priority];

  return {
    state: {
      requestedModel: input.requestedModel ?? null,
      candidates: input.candidates,
      rules: [
        "Only choose cheap or fast when a rank is available; never invent a price.",
        "A reasoning-heavy task should not take the cheapest model blindly.",
      ],
    },
    model: "jev-latest",
    questions: {
      priority: choice("Which priority did the user state or imply?", priorityCriteria),
      priority_named: {
        type: "noul",
        instructions: "Did the user state or clearly imply a cost, speed, or quality priority?",
        criteria: {
          true: "A priority is stated or strongly implied.",
          false: "No priority; use the configured default.",
        },
      },
      is_reasoning_heavy: {
        type: "noul",
        instructions:
          "Does the task need deep reasoning (architecture, debugging, multi-file refactor)?",
        criteria: { true: "Reasoning-heavy.", false: "Small or mechanical." },
      },
      model: choice("Did the user name a specific model?", modelCriteria),
      user_named_model: {
        type: "noul",
        instructions: "Did the user name a specific model?",
        criteria: { true: "A model was named.", false: "No model was named." },
      },
    },
  };
}

export type ModelRoute =
  | {
      readonly status: "routed";
      readonly key: string;
      readonly provider: string;
      readonly model: string;
      readonly priority: RoutingPriority;
      readonly reason: string;
    }
  | { readonly status: "clarify"; readonly prompt: string };

const bestBy = (
  candidates: ReadonlyArray<ModelRouteCandidate>,
  rank: keyof Pick<ModelRouteCandidate, "costRank" | "speedRank" | "qualityRank">,
  direction: "min" | "max",
): ModelRouteCandidate | undefined => {
  const scored = candidates.filter((candidate) => candidate[rank] !== undefined);
  if (scored.length === 0) return undefined;
  return scored.reduce((best, candidate) => {
    const left = candidate[rank]!;
    const right = best[rank]!;
    return direction === "min"
      ? left < right
        ? candidate
        : best
      : left > right
        ? candidate
        : best;
  });
};

export function pickRoute(input: {
  readonly candidates: ReadonlyArray<ModelRouteCandidate>;
  readonly priority: RoutingPriority;
}): ModelRouteCandidate | undefined {
  switch (input.priority) {
    case "cheap":
      return bestBy(input.candidates, "costRank", "min");
    case "fast":
      return bestBy(input.candidates, "speedRank", "max");
    case "best":
      return bestBy(input.candidates, "qualityRank", "max");
    case "default":
      return (
        input.candidates.find((candidate) => candidate.isDefault === true) ?? input.candidates[0]
      );
  }
}

/**
 * A named model always wins. Otherwise a stated priority ranks the real
 * catalog; when the rank data is missing, code falls back to the default and
 * says why rather than claiming a cheap pick it cannot justify.
 */
export function composeModelRoute(input: {
  readonly candidates: ReadonlyArray<ModelRouteCandidate>;
  readonly answers: DecisionAnswers;
}): ModelRoute {
  const named = noulHolds(input.answers, "user_named_model", 0.5) ?? false;
  const selected = choiceAnswer(input.answers, "model")?.choice;
  if (named && selected !== undefined && selected !== NONE_OPTION) {
    const candidate = input.candidates.find((entry) => entry.key === selected);
    if (candidate !== undefined) {
      return {
        status: "routed",
        key: candidate.key,
        provider: candidate.provider,
        model: candidate.model,
        priority: "default",
        reason: "You named this model.",
      };
    }
  }

  const priorityNamed = noulHolds(input.answers, "priority_named", 0.5) ?? false;
  const reasoningHeavy = noulHolds(input.answers, "is_reasoning_heavy", 0.5) ?? false;
  const priority =
    (choiceAnswer(input.answers, "priority")?.choice as RoutingPriority | undefined) ?? "default";

  if (!priorityNamed || priority === "default") {
    const fallback = pickRoute({ candidates: input.candidates, priority: "default" });
    if (fallback === undefined)
      return { status: "clarify", prompt: "Which provider should I use?" };
    return {
      status: "routed",
      key: fallback.key,
      provider: fallback.provider,
      model: fallback.model,
      priority: "default",
      reason: "No priority given; using the default.",
    };
  }

  const chosen = pickRoute({ candidates: input.candidates, priority });
  if (chosen === undefined) {
    const fallback = pickRoute({ candidates: input.candidates, priority: "default" });
    if (fallback === undefined)
      return { status: "clarify", prompt: "Which provider should I use?" };
    return {
      status: "routed",
      key: fallback.key,
      provider: fallback.provider,
      model: fallback.model,
      priority: "default",
      reason: `No ${priority} rating is available; using the default.`,
    };
  }
  if (reasoningHeavy && priority === "cheap") {
    const capable = bestBy(input.candidates, "qualityRank", "max") ?? chosen;
    return {
      status: "routed",
      key: capable.key,
      provider: capable.provider,
      model: capable.model,
      priority: "best",
      reason: "The task needs reasoning, so I did not take the cheapest model.",
    };
  }
  return {
    status: "routed",
    key: chosen.key,
    provider: chosen.provider,
    model: chosen.model,
    priority,
    reason: `Chosen for ${priority}.`,
  };
}
