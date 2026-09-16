/**
 * The TypeSafe System One decision protocol and the finite decision it
 * carries.
 *
 * A decision is a tuple of selections over supplied finite sets: the model
 * only ever picks an element of a finite set or evaluates a boolean
 * predicate. It never produces spans, IDs, free text, sequences, or numbers
 * outside a set; those are derived in code from the selection plus the
 * original utterance. Everything in this module after the wire types is the
 * deterministic request builder and derivation.
 */

export type DecisionChoiceQuestion = {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string | null>>;
};

export type DecisionScoreQuestion = {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: ReadonlyArray<string>;
};

export type DecisionNoulQuestion = {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
};

export type DecisionQuestion =
  | DecisionChoiceQuestion
  | DecisionScoreQuestion
  | DecisionNoulQuestion;

/**
 * One System One request. `state` is structured host context with no internal
 * IDs (project and task lists are keyed by human-readable names); questions is
 * the named map of finite selections and predicates.
 */
export interface DecisionRequest {
  readonly state: unknown;
  readonly model: string;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

export type DecisionChoiceAnswer = {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type DecisionScoreAnswer = {
  readonly type: "score";
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
};

export type DecisionNoulAnswer = {
  readonly type: "noul";
  readonly noul: number;
};

export type DecisionAnswer = DecisionChoiceAnswer | DecisionScoreAnswer | DecisionNoulAnswer;

export type DecisionAnswers = Readonly<Record<string, DecisionAnswer>>;

export type CirceDecisionDeclineReason =
  | "decision-disabled"
  | "decision-unconfigured"
  | "source-too-large"
  | "decision-timeout"
  | "decision-rate-limited"
  | "decision-network-error"
  | "decision-http-error"
  | "decision-invalid-response";

export type CirceDecisionOutcome =
  | {
      readonly status: "answered";
      /** The exact model that answered, recorded per turn. Aliases move. */
      readonly model: string;
      readonly answers: DecisionAnswers;
    }
  | { readonly status: "decline"; readonly reason: CirceDecisionDeclineReason };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const readProbabilities = (value: unknown): Record<string, number> | undefined => {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, probability] of Object.entries(value)) {
    if (!isProbability(probability)) return undefined;
    out[key] = probability;
  }
  return out;
};

const readAnswer = (value: unknown): DecisionAnswer | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.type === "choice") {
    const probabilities = readProbabilities(value.probabilities);
    if (typeof value.choice !== "string" || probabilities === undefined) return undefined;
    if (!isProbability(value.confidence)) return undefined;
    return {
      type: "choice",
      choice: value.choice,
      probabilities,
      confidence: value.confidence,
    };
  }
  if (value.type === "score") {
    const probabilities = readProbabilities(value.probabilities);
    if (!isProbability(value.confidence) || !Number.isFinite(value.score)) return undefined;
    if (!isRecord(value.legend) || probabilities === undefined) return undefined;
    const legend: Record<string, string> = {};
    for (const [key, label] of Object.entries(value.legend)) {
      if (typeof label !== "string") return undefined;
      legend[key] = label;
    }
    return {
      type: "score",
      score: value.score as number,
      legend,
      probabilities,
      confidence: value.confidence,
    };
  }
  if (value.type === "noul") {
    if (!isProbability(value.noul)) return undefined;
    return { type: "noul", noul: value.noul };
  }
  return undefined;
};

/**
 * Parse one System One response body. Unknown or malformed shapes return
 * undefined so the caller declines; a partial answer set is accepted because
 * per-question membership is checked by the composer, not here.
 */
export function readDecisionResponse(
  body: unknown,
): { readonly model: string; readonly answers: DecisionAnswers } | undefined {
  if (!isRecord(body) || typeof body.model !== "string") return undefined;
  if (!isRecord(body.answers)) return undefined;
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, rawAnswer] of Object.entries(body.answers)) {
    const answer = readAnswer(rawAnswer);
    if (answer === undefined) return undefined;
    answers[id] = answer;
  }
  return { model: body.model, answers };
}

/** Choice answer with its confidence, or undefined when absent/wrong type. */
export function choiceAnswer(
  answers: DecisionAnswers,
  id: string,
): DecisionChoiceAnswer | undefined {
  const answer = answers[id];
  return answer?.type === "choice" ? answer : undefined;
}

/** Noul answer value in [0,1], or undefined when absent/wrong type. */
export function noulAnswer(answers: DecisionAnswers, id: string): number | undefined {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : undefined;
}

/** Noul as a boolean at the supplied threshold; undefined when absent. */
export function noulHolds(
  answers: DecisionAnswers,
  id: string,
  threshold: number,
): boolean | undefined {
  const value = noulAnswer(answers, id);
  return value === undefined ? undefined : value >= threshold;
}
