/**
 * Project memory policy, pure and testable. The store owns persistence; this
 * module owns the two decisions that keep memory useful instead of noisy:
 * which entries are eligible for the index, and when a claim may become a
 * fact. Everything here is a view with epoch milliseconds, so no date parsing
 * lives in policy.
 */

export const CIRCE_MEMORY_INDEX_BUDGET_TOKENS = 1_200;
/** Corroboration needed before an unconfirmed agent claim becomes a fact. */
export const CIRCE_MEMORY_PROMOTION_CORROBORATIONS = 2;

export interface CirceMemoryView {
  readonly id: string;
  readonly kind: "episode" | "fact";
  readonly source: "user" | "agent" | "system";
  readonly title: string;
  readonly body: string;
  readonly tags: ReadonlyArray<string>;
  readonly status: "active" | "retired";
  readonly updatedAtMs: number;
  readonly expiresAtMs: number | null;
}

/** Rough body cost, deliberately conservative, for the index's cost signal. */
export function estimateMemoryTokens(body: string): number {
  return Math.ceil(body.length / 4);
}

/** Active and not expired. A retired or expired entry never reaches a thread. */
export function memoryIsLive(entry: CirceMemoryView, nowMs: number): boolean {
  if (entry.status !== "active") return false;
  return entry.expiresAtMs === null || entry.expiresAtMs > nowMs;
}

/**
 * A claim may be stored as a fact only with evidence beyond one mention:
 * the user said so, or it was seen enough times, or the user explicitly asked
 * to remember it. Untrusted content is never a fact source.
 */
export function memoryMayBeFact(input: {
  readonly source: CirceMemoryView["source"];
  readonly corroborationCount: number;
  readonly confirmed: boolean;
}): boolean {
  if (input.source === "system") return false;
  if (input.confirmed) return true;
  return input.corroborationCount >= CIRCE_MEMORY_PROMOTION_CORROBORATIONS;
}

/**
 * The compact map a thread sees. Facts rank above episodes, then recency, and
 * the list stops at the token budget so a long-lived project cannot bloat a
 * prompt. Bodies stay behind an explicit fetch.
 */
export interface CirceMemoryIndexView {
  readonly id: string;
  readonly kind: "episode" | "fact";
  readonly source: "user" | "agent" | "system";
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
  readonly tokens: number;
}

export function buildMemoryIndex(
  entries: ReadonlyArray<CirceMemoryView>,
  options: { readonly nowMs: number; readonly budgetTokens?: number },
): { readonly entries: ReadonlyArray<CirceMemoryIndexView>; readonly totalTokens: number } {
  const budget = options.budgetTokens ?? CIRCE_MEMORY_INDEX_BUDGET_TOKENS;
  const live = entries
    .filter((entry) => memoryIsLive(entry, options.nowMs))
    .slice()
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "fact" ? -1 : 1;
      return right.updatedAtMs - left.updatedAtMs;
    });
  const index: Array<CirceMemoryIndexView> = [];
  let totalTokens = 0;
  for (const entry of live) {
    const tokens = estimateMemoryTokens(entry.body);
    if (totalTokens + tokens > budget && index.length > 0) break;
    index.push({
      id: entry.id,
      kind: entry.kind,
      source: entry.source,
      title: entry.title,
      tags: [...entry.tags],
      tokens,
    });
    totalTokens += tokens;
  }
  return { entries: index, totalTokens };
}
