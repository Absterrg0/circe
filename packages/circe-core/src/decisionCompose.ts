import type { CirceCommandNeedsInput } from "./command.ts";
import { choiceAnswer, noulHolds, type DecisionAnswers } from "./decision.ts";
import {
  CIRCE_DECISION_THRESHOLDS,
  locateDestinationWrapper,
  locateNameSpan,
  riskForAction,
  thresholdForRisk,
  type BoundaryCandidate,
  type DecisionOptionTable,
  type DecisionSegment,
  type DecisionState,
  type LocatedSpan,
} from "./decisionRequest.ts";
import type {
  CirceSemanticProposal,
  CirceSemanticStep,
  SemanticRef,
  SemanticRole,
} from "./semanticEvidence.ts";
import { NONE_OPTION, findCirceTool } from "./toolRegistry.ts";

/**
 * Deterministic composition of a decision into the internal proposal form.
 *
 * Every field of the proposal is derived here from the finite selections plus
 * the original utterance: spans are located by code and must reproduce the
 * source byte-for-byte, refs are ordered, and routing authority stays with the
 * Director. A selection that cannot be located rejects the classification and
 * asks; it never falls back to generation.
 */

export type DecisionComposition =
  | { readonly status: "proposal"; readonly proposal: CirceSemanticProposal }
  | ({ readonly status: "needs-input" } & CirceCommandNeedsInput);

interface SingleCommand {
  readonly action: CirceSemanticProposal["action"];
  readonly refs: ReadonlyArray<SemanticRef>;
  readonly model: string | null;
  readonly effort: string | null;
  readonly answer: string | null;
  readonly lookup?: CirceSemanticProposal["lookup"];
  readonly website?: CirceSemanticProposal["website"];
}

const clarify = (
  prompt: string,
  refinement?: NonNullable<CirceCommandNeedsInput["refinement"]>,
): DecisionComposition => ({
  status: "needs-input",
  reason: "unsupported-command",
  prompt,
  choices: [],
  ...(refinement === undefined ? {} : { refinement }),
});

const needsTarget = (prompt: string): DecisionComposition => ({
  status: "needs-input",
  reason: "control-target-required",
  prompt,
  choices: [],
});

const makeRef = (span: LocatedSpan, role: SemanticRole, value: string): SemanticRef => ({
  span: { start: span.start, end: span.end, text: span.text },
  role,
  value,
});

const firstLocated = (
  source: string,
  names: ReadonlyArray<string>,
  locate: (source: string, name: string) => LocatedSpan | undefined,
): LocatedSpan | undefined => {
  const ordered = [...names].sort((left, right) => right.length - left.length);
  for (const name of ordered) {
    const span = locate(source, name);
    if (span !== undefined) return span;
  }
  return undefined;
};

const asDay = (value: string | undefined): "now" | "today" | "tomorrow" =>
  value === "today" || value === "tomorrow" ? value : "now";

interface ComposeSingleInput {
  readonly source: string;
  readonly table: DecisionOptionTable;
  readonly answers: DecisionAnswers;
  readonly prefix: string;
}

function composeRefs(input: ComposeSingleInput): {
  readonly refs: ReadonlyArray<SemanticRef>;
  readonly lookup?: SingleCommand["lookup"];
  readonly website?: SingleCommand["website"];
  readonly model: string | null;
  readonly effort: string | null;
  readonly error?: DecisionComposition;
} {
  const { source, table, answers, prefix } = input;
  const id = (name: string): string => `${prefix}${name}`;
  const choice = (name: string, threshold: number) => {
    const answer = choiceAnswer(answers, id(name));
    return answer !== undefined && answer.confidence >= threshold ? answer : undefined;
  };
  const predicate = (name: string, threshold: number): boolean =>
    noulHolds(answers, id(name), threshold) ?? false;

  const refs: Array<SemanticRef> = [];

  // Destination. Only destination or correction maps to a route; a negated
  // target is a veto, so it is cited as excluded and never authorizes.
  const projectKey = choice("destination_project", CIRCE_DECISION_THRESHOLDS.readOnly)?.choice;
  if (projectKey !== undefined && projectKey !== NONE_OPTION) {
    const entry = table.projects.find((project) => project.key === projectKey);
    if (entry === undefined)
      return {
        refs,
        model: null,
        effort: null,
        error: clarify("I couldn't match that project. Which project did you mean?"),
      };
    const negated = predicate("destination_negated", CIRCE_DECISION_THRESHOLDS.predicate);
    if (negated) {
      const span = firstLocated(source, entry.names, locateNameSpan);
      if (span === undefined)
        return {
          refs,
          model: null,
          effort: null,
          error: clarify("I couldn't find that project in what you said. Say it again."),
        };
      refs.push(makeRef(span, "excluded", span.text));
    } else {
      const span = firstLocated(source, entry.names, locateDestinationWrapper);
      if (span === undefined)
        return {
          refs,
          model: null,
          effort: null,
          error: clarify("I couldn't find that project in what you said. Say it again."),
        };
      refs.push(makeRef(span, "destination", entry.title));
    }
  }

  const taskKey = choice("task", CIRCE_DECISION_THRESHOLDS.readOnly)?.choice;
  if (taskKey !== undefined && taskKey !== NONE_OPTION) {
    const entry = table.tasks.find((task) => task.key === taskKey);
    if (entry === undefined)
      return {
        refs,
        model: null,
        effort: null,
        error: clarify("I couldn't match that task. Which task did you mean?"),
      };
    const span = firstLocated(source, entry.names, locateNameSpan);
    if (span === undefined)
      return {
        refs,
        model: null,
        effort: null,
        error: clarify("I couldn't find that task in what you said. Say it again."),
      };
    refs.push(makeRef(span, "task", entry.title));
  }

  const providerKey = choice("provider", CIRCE_DECISION_THRESHOLDS.readOnly)?.choice;
  if (providerKey !== undefined && providerKey !== NONE_OPTION) {
    const entry = table.providers.find((provider) => provider.key === providerKey);
    if (entry === undefined)
      return {
        refs,
        model: null,
        effort: null,
        error: clarify("I couldn't match that provider. Which provider did you mean?"),
      };
    const span = firstLocated(source, entry.names, locateNameSpan);
    if (span === undefined)
      return {
        refs,
        model: null,
        effort: null,
        error: clarify("I couldn't find that provider in what you said. Say it again."),
      };
    refs.push(makeRef(span, "provider", span.text));
  }

  let model: string | null = null;
  if (predicate("model_specified", CIRCE_DECISION_THRESHOLDS.predicate)) {
    const answer = choice("model", CIRCE_DECISION_THRESHOLDS.readOnly);
    if (answer === undefined)
      return {
        refs,
        model: null,
        effort: null,
        error: clarify("I couldn't tell which model you meant. Say its name."),
      };
    if (answer.choice !== NONE_OPTION) {
      const slash = answer.choice.indexOf("/");
      model = slash === -1 ? answer.choice : answer.choice.slice(slash + 1);
    }
  }

  let effort: string | null = null;
  if (predicate("effort_specified", CIRCE_DECISION_THRESHOLDS.predicate)) {
    const answer = choice("effort", CIRCE_DECISION_THRESHOLDS.readOnly);
    if (answer === undefined)
      return {
        refs,
        model: null,
        effort: null,
        error: clarify("I couldn't tell which effort level you meant. Say it again."),
      };
    if (answer.choice !== NONE_OPTION) {
      effort = table.efforts.find((candidate) => candidate.key === answer.choice)?.id ?? null;
    }
  }

  return { refs, model, effort };
}

function composeSingle(input: ComposeSingleInput): SingleCommand | DecisionComposition {
  const { source, table, answers, prefix } = input;
  const id = (name: string): string => `${prefix}${name}`;
  const choice = (name: string, threshold: number) => {
    const answer = choiceAnswer(answers, id(name));
    return answer !== undefined && answer.confidence >= threshold ? answer : undefined;
  };
  const predicate = (name: string, threshold: number): boolean =>
    noulHolds(answers, id(name), threshold) ?? false;

  if (predicate("needs_clarification", CIRCE_DECISION_THRESHOLDS.clarification)) {
    return clarify("I need a little more detail before I act. What exactly should I do?");
  }

  // An approval verdict is never granted by the classifier. It becomes a
  // continue so the Director binds it to typed pending state, which is the
  // only authority for allow or deny.
  if (predicate("contains_approval_verdict", CIRCE_DECISION_THRESHOLDS.predicate)) {
    return { action: "continue", refs: [], model: null, effort: null, answer: null };
  }

  const strategy = choice("response_strategy", CIRCE_DECISION_THRESHOLDS.readOnly)?.choice;
  if (strategy === undefined) {
    return clarify("I couldn't tell what you want me to do. Say the action and the target.");
  }

  const resolved = composeRefs(input);
  if (resolved.error !== undefined) return resolved.error;
  const { refs } = resolved;

  if (strategy === "refuse") {
    return {
      action: "unsupported",
      refs,
      model: resolved.model,
      effort: resolved.effort,
      answer: null,
    };
  }

  if (strategy === "tool") {
    const toolKey = choice("tool", CIRCE_DECISION_THRESHOLDS.readOnly)?.choice;
    const tool = toolKey === undefined ? undefined : findCirceTool(toolKey);
    if (tool === undefined) {
      return clarify("I couldn't tell which lookup you wanted. Say it again.");
    }
    if (tool.action === "lookup") {
      const lookupKind = tool.name === "weather" ? "weather" : "time";
      const location = choice(`tool_${tool.name}_location`, CIRCE_DECISION_THRESHOLDS.readOnly);
      if (location === undefined || location.choice === NONE_OPTION) {
        return clarify("I couldn't tell which place you meant. Name the city.", {
          kind: "lookup",
          lookupKind,
        });
      }
      if (locateNameSpan(source, location.choice) === undefined) {
        return clarify("I couldn't match that place to what you said. Name the city again.", {
          kind: "lookup",
          lookupKind,
        });
      }
      const day = choice(`tool_${tool.name}_day`, CIRCE_DECISION_THRESHOLDS.predicate)?.choice;
      return {
        action: "lookup",
        refs: [],
        model: null,
        effort: null,
        answer: null,
        lookup: {
          kind: lookupKind,
          location: location.choice,
          day: asDay(day),
        },
      };
    }
    if (tool.action === "open-website") {
      const website = choice("tool_open-website_website", CIRCE_DECISION_THRESHOLDS.readOnly);
      if (website === undefined || website.choice === NONE_OPTION) {
        return clarify("I couldn't tell which site you wanted. Say the site or address.", {
          kind: "website",
        });
      }
      if (locateNameSpan(source, website.choice) === undefined) {
        return clarify("I couldn't match that site to what you said. Say it again.", {
          kind: "website",
        });
      }
      return {
        action: "open-website",
        refs: [],
        model: null,
        effort: null,
        answer: null,
        website: website.choice,
      };
    }
    if (tool.action === "status") {
      return { action: "status", refs, model: null, effort: null, answer: null };
    }
    return { action: "list-projects", refs: [], model: null, effort: null, answer: null };
  }

  if (strategy === "status_report") {
    return { action: "status", refs, model: resolved.model, effort: resolved.effort, answer: null };
  }
  if (strategy === "list_report") {
    return { action: "list-projects", refs: [], model: null, effort: null, answer: null };
  }
  if (strategy === "conversation_thread") {
    return { action: "converse", refs, model: null, effort: null, answer: null };
  }

  const actionAnswer = choice("action", CIRCE_DECISION_THRESHOLDS.readOnly);
  if (actionAnswer === undefined) {
    return table.projects.length === 0 && refs.length === 0
      ? needsTarget("I don't have a recent Circe task to apply that to.")
      : clarify("I couldn't tell which action you want. Say the action and the target.");
  }
  const action = actionAnswer.choice as CirceSemanticProposal["action"];
  if (action === "lookup" || action === "open-website" || action === "unsupported") {
    return clarify("I couldn't do that as one action. Say it another way.");
  }
  // Risk gate: confidence must clear the threshold for the action's risk,
  // and destructive controls always carry host confirmation in the Director.
  if (actionAnswer.confidence < thresholdForRisk(riskForAction(action))) {
    return clarify("I'm not confident enough to act on that. Say it again more precisely.");
  }
  if (
    refs.length === 0 &&
    (action === "focus-project" ||
      action === "focus-task" ||
      action === "stop" ||
      action === "reroute")
  ) {
    return needsTarget("I don't have a recent Circe task to apply that to.");
  }
  return {
    action,
    refs: [...refs].sort((left, right) => left.span.start - right.span.start),
    model: resolved.model,
    effort: resolved.effort,
    answer: null,
  };
}

const toProposal = (command: SingleCommand): CirceSemanticProposal => ({
  action: command.action,
  refs: command.refs,
  model: command.model,
  effort: command.effort,
  answer: command.answer,
  ...(command.lookup === undefined ? {} : { lookup: command.lookup }),
  ...(command.website === undefined ? {} : { website: command.website }),
});

export interface ComposeDecisionInput {
  readonly source: string;
  readonly table: DecisionOptionTable;
  /** Answers for the whole-utterance questions; omitted for compound turns. */
  readonly answers?: DecisionAnswers;
  readonly boundaries: ReadonlyArray<BoundaryCandidate>;
  readonly state: DecisionState;
  /** Accepted segments when the turn is a compound; two or more. */
  readonly segments?: ReadonlyArray<DecisionSegment>;
  /** Per-segment answers, keyed `seg<i>_*`, aligned with `segments`. */
  readonly segmentAnswers?: ReadonlyArray<DecisionAnswers>;
}

const isNeedsInput = (value: SingleCommand | DecisionComposition): value is DecisionComposition =>
  "status" in value;

/**
 * Compose the decision into a proposal or a needs-input outcome. Compound
 * turns run the same single-command composition once per accepted segment and
 * assemble an ordered sequence with host-derived spans; the Director validates
 * every step before dispatching any.
 */
export function composeDecision(input: ComposeDecisionInput): DecisionComposition {
  const segments = input.segments;
  const segmentAnswers = input.segmentAnswers;
  if (
    segments !== undefined &&
    segmentAnswers !== undefined &&
    segments.length >= 2 &&
    segmentAnswers.length === segments.length
  ) {
    const steps: Array<CirceSemanticStep> = [];
    for (const [index, segment] of segments.entries()) {
      const composed = composeSingle({
        source: segment.text,
        table: input.table,
        answers: segmentAnswers[index]!,
        prefix: `seg${index}_`,
      });
      if (isNeedsInput(composed)) return composed;
      if (
        composed.action === "lookup" ||
        composed.action === "open-website" ||
        composed.action === "browse" ||
        composed.action === "computer" ||
        composed.action === "unsupported" ||
        composed.action === "sequence"
      ) {
        return clarify("A step in that turn can't run on its own. Say each step separately.");
      }
      steps.push({
        action: composed.action,
        refs: composed.refs.map((ref) => ({
          ...ref,
          span: {
            start: ref.span.start + segment.start,
            end: ref.span.end + segment.start,
            text: ref.span.text,
          },
        })),
        sourceSpan: { start: segment.start, end: segment.end },
        model: composed.model,
        effort: composed.effort,
        answer: composed.answer,
      });
    }
    return {
      status: "proposal",
      proposal: {
        action: "sequence",
        refs: [],
        model: null,
        effort: null,
        answer: null,
        steps,
      },
    };
  }

  const composed = composeSingle({
    source: input.source,
    table: input.table,
    answers: input.answers ?? {},
    prefix: "",
  });
  if (isNeedsInput(composed)) return composed;
  if (composed.action === "sequence") {
    return clarify("That is more than one action. Say the first step on its own.");
  }
  return { status: "proposal", proposal: toProposal(composed) };
}

/** Accepted boundaries from their Noul answers, in source order. */
export function acceptedBoundaries(
  boundaries: ReadonlyArray<BoundaryCandidate>,
  answers: DecisionAnswers,
): ReadonlyArray<BoundaryCandidate> {
  return boundaries.filter(
    (boundary) => noulHolds(answers, boundary.id, CIRCE_DECISION_THRESHOLDS.boundary) === true,
  );
}
