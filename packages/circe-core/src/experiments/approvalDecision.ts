import {
  choiceAnswer,
  noulHolds,
  type DecisionAnswers,
  type DecisionRequest,
} from "../decision.ts";

/**
 * Experiment: finite risk classification and grant scoping for approvals.
 *
 * Today approvals are near-binary. `describeApproval` derives risk only from
 * the request kind, has no case for commands, and trusts any provider-claimed
 * risk tier. The only scopes are the four global modes plus a conflated
 * "allow for this task". So the user's real choice ("let it read files but
 * never touch the network") does not exist.
 *
 * This classifies the specific request against a closed tier and a closed
 * grant scope, then code enforces the hard rules. Nothing here dispatches; it
 * returns a normalized decision the host can apply.
 */

export type ApprovalRiskTier =
  | "read"
  | "read-and-compute"
  | "workspace-write"
  | "external-effect"
  | "destructive"
  | "unknown";

export type ApprovalScope =
  | "ask-every-time"
  | "allow-reads"
  | "allow-edits"
  | "allow-this-tool-for-task"
  | "allow-all-for-task";

export interface ApprovalRequestSummary {
  readonly requestKind: string;
  readonly toolName?: string;
  readonly command?: string;
  /** The request falls inside a grant the user already gave for this task. */
  readonly withinStandingGrant: boolean;
  readonly standingScope?: ApprovalScope;
}

const TIERS = new Set<ApprovalRiskTier>([
  "read",
  "read-and-compute",
  "workspace-write",
  "external-effect",
  "destructive",
]);
const SCOPES = new Set<ApprovalScope>([
  "ask-every-time",
  "allow-reads",
  "allow-edits",
  "allow-this-tool-for-task",
  "allow-all-for-task",
]);

const TIER_RANK: Readonly<Record<ApprovalRiskTier, number>> = {
  read: 1,
  "read-and-compute": 2,
  "workspace-write": 3,
  "external-effect": 4,
  destructive: 5,
  unknown: 6,
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

export function buildApprovalDecisionRequest(input: {
  readonly request: ApprovalRequestSummary;
}): DecisionRequest {
  const tierCriteria: Record<string, string | null> = {
    read: "Reads a file or inspects state; changes nothing.",
    "read-and-compute": "Reads and runs a local computation (tests, build, grep).",
    "workspace-write": "Writes inside the project workspace only.",
    "external-effect": "Reaches the network, publishes, pushes, or spends money.",
    destructive: "Deletes or overwrites something that cannot be recovered by git.",
    unknown: "Cannot be classified from the request.",
  };
  const scopeCriteria: Record<string, string | null> = {
    "ask-every-time": "Never auto-approve this kind of request.",
    "allow-reads": "Allow reads for the rest of this task.",
    "allow-edits": "Allow workspace writes for the rest of this task.",
    "allow-this-tool-for-task": "Allow this specific tool for the rest of this task.",
    "allow-all-for-task": "Allow everything for the rest of this task.",
  };
  return {
    state: {
      requestKind: input.request.requestKind,
      toolName: input.request.toolName ?? null,
      command: input.request.command?.slice(0, 2_000) ?? null,
      withinStandingGrant: input.request.withinStandingGrant,
    },
    model: "jev-latest",
    questions: {
      risk: choice("How risky is this specific request?", tierCriteria),
      grant_scope: choice(
        "If the user approves, what should the standing grant cover?",
        scopeCriteria,
      ),
      touches_outside_workspace: noul(
        "Does it write or delete outside the project workspace?",
        "Writes outside the workspace.",
        "Stays inside the workspace.",
      ),
      irreversible: noul(
        "Would git or a backup fail to recover what it changes?",
        "Not recoverable.",
        "Recoverable.",
      ),
      network_or_secrets: noul(
        "Does it reach the network or touch credentials?",
        "Network or credentials involved.",
        "Fully local.",
      ),
      identity_confident: noul(
        "Does the request unambiguously identify one operation?",
        "One clear operation.",
        "Ambiguous or truncated.",
      ),
    },
  };
}

export type ApprovalPlan =
  | {
      readonly status: "auto-accept";
      readonly decision: "accept" | "acceptForSession";
      readonly scope: ApprovalScope;
      readonly reason: string;
    }
  | { readonly status: "ask"; readonly scope: ApprovalScope; readonly reason: string }
  | { readonly status: "ask-always"; readonly reason: string };

/** Safety never trusts a low tier: any danger predicate forces a high floor. */
export function effectiveRiskTier(
  answers: DecisionAnswers,
  request: ApprovalRequestSummary,
): ApprovalRiskTier {
  const selected = choiceAnswer(answers, "risk")?.choice as ApprovalRiskTier | undefined;
  let tier =
    selected !== undefined && TIERS.has(selected) ? selected : ("unknown" as ApprovalRiskTier);
  if (noulHolds(answers, "irreversible", 0.5) === true) tier = "destructive";
  else if (
    noulHolds(answers, "network_or_secrets", 0.5) === true ||
    noulHolds(answers, "touches_outside_workspace", 0.5) === true
  ) {
    if (TIER_RANK[tier] < TIER_RANK["external-effect"]) tier = "external-effect";
  }
  // A blank or unparseable request is never treated as low risk.
  if (request.command === undefined && request.toolName === undefined) {
    if (TIER_RANK[tier] < TIER_RANK.unknown) tier = "unknown";
  }
  return tier;
}

const scopeForTier = (tier: ApprovalRiskTier): ApprovalScope => {
  switch (tier) {
    case "read":
    case "read-and-compute":
      return "allow-reads";
    case "workspace-write":
      return "allow-edits";
    case "external-effect":
      return "allow-this-tool-for-task";
    default:
      return "ask-every-time";
  }
};

/**
 * Code owns the outcome:
 * - destructive, external, irreversible, unknown, or ambiguous never
 *   auto-accept and never offer a standing grant;
 * - only a confident, in-workspace read or edit inside an existing grant may
 *   auto-accept, and only within that grant's scope.
 */
export function composeApprovalPlan(input: {
  readonly request: ApprovalRequestSummary;
  readonly answers: DecisionAnswers;
}): ApprovalPlan {
  const { request, answers } = input;
  const tier = effectiveRiskTier(answers, request);
  const confident = noulHolds(answers, "identity_confident", 0.5) ?? false;
  const selectedScope = choiceAnswer(answers, "grant_scope")?.choice as ApprovalScope | undefined;
  const proposedScope =
    selectedScope !== undefined && SCOPES.has(selectedScope) ? selectedScope : scopeForTier(tier);

  if (tier === "destructive") {
    return { status: "ask-always", reason: "It cannot be recovered if it goes wrong." };
  }
  if (tier === "external-effect") {
    return { status: "ask", scope: "ask-every-time", reason: "It reaches outside the workspace." };
  }
  if (tier === "unknown" || !confident) {
    return { status: "ask", scope: "ask-every-time", reason: "I can't tell exactly what it does." };
  }

  const eligible =
    request.withinStandingGrant &&
    (tier === "read" || tier === "read-and-compute" || tier === "workspace-write");
  if (eligible) {
    return {
      status: "auto-accept",
      decision: "acceptForSession",
      scope: request.standingScope ?? scopeForTier(tier),
      reason: "It falls inside the grant you already gave this task.",
    };
  }
  return {
    status: "ask",
    scope: tier === "read" || tier === "read-and-compute" ? "allow-reads" : proposedScope,
    reason: "It is new for this task.",
  };
}
