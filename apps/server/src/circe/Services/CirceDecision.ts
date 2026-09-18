import type { DecisionRequest, CirceDecisionOutcome } from "@circe/core/decision";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Runtime config for the System One decision tier.
 *
 * `enabled` is tri-state. Unset means the node is managed: it uses a local key
 * when one is configured, otherwise the linked relay's deployment key, and
 * declines when neither exists. `enabled: false` turns the tier off entirely,
 * even on a linked node. `enabled: true` requires a path and otherwise declines
 * as unconfigured. The key is server-side only; it is never read by a client
 * bundle. The model id is pinned by default because aliases move, and the
 * resolved `response.model` is recorded per turn.
 */
export interface CirceDecisionConfig {
  readonly enabled: boolean | undefined;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly endpoint: string;
}

export const CIRCE_DECISION_DEFAULT: CirceDecisionConfig = {
  enabled: undefined,
  apiKey: "",
  model: "jev-latest",
  timeoutMs: 5_000,
  endpoint: "https://api.typesafe.ai",
};

/**
 * One finite decision over supplied sets. Returns a typed answered outcome or
 * a decline with a reason; it never fails the turn. The classifier is the
 * only non-deterministic step in the pipeline; callers validate every answer
 * against their catalogs before deriving anything.
 */
export class CirceDecision extends Context.Service<
  CirceDecision,
  {
    readonly decide: (request: DecisionRequest) => Effect.Effect<CirceDecisionOutcome>;
  }
>()("@absterrg0/circe/circe/Services/CirceDecision") {}
