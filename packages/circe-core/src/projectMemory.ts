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

/**
 * The pinned block a thread sees. It is a map, not the memory: titles with a
 * cost and an id, plus one instruction to fetch a body on demand. Kept short
 * on purpose so the stable prefix stays cacheable and the window stays for the
 * task. Empty memory renders nothing at all.
 */
export function renderMemoryIndex(input: {
  readonly entries: ReadonlyArray<CirceMemoryIndexView>;
  readonly totalTokens: number;
}): string {
  if (input.entries.length === 0) return "";
  const lines = input.entries.map(
    (entry) =>
      `- [${entry.kind}/${entry.source}] ${entry.title} (${entry.tokens} tokens, id ${entry.id})`,
  );
  return [
    `Project memory index (${input.entries.length} entries, ~${input.totalTokens} tokens of bodies):`,
    ...lines,
    "This is a map, not the content. Fetch a body by id when it matters to the task.",
  ].join("\n");
}

export interface CirceMemoryBodyView {
  readonly id: string;
  readonly kind: "episode" | "fact";
  readonly source: "user" | "agent" | "system";
  readonly title: string;
  readonly body: string;
  /** Already formatted by the caller, so policy does no date math. */
  readonly updatedAt: string;
}

/**
 * A fetched body is labeled as recalled information with its kind, source, and
 * timestamp, never as an instruction. A model told "the user said on this date
 * X" can override it; one told "X" treats it as a standing rule. Facts and
 * episodes carry the same label so provenance is always visible.
 */
export interface ProjectPinnedContextInput {
  readonly projectTitle: string;
  /** Short, stable statement of the project's goal and conventions. */
  readonly brief?: string;
  /** Result of `renderMemoryIndex`; empty string when there is no memory. */
  readonly memoryIndexBlock: string;
}

/**
 * The whole pinned layer for a coordinator turn: identity, the brief, and the
 * memory map. Nothing else is preloaded. Workers get this at thread creation;
 * the coordinator keeps it for routing. Stable and short so it caches.
 */
export function buildProjectPinnedContext(input: ProjectPinnedContextInput): string {
  const parts = [`Project: ${input.projectTitle}`];
  const brief = input.brief?.trim();
  if (brief !== undefined && brief.length > 0) parts.push(brief);
  if (input.memoryIndexBlock.length > 0) parts.push(input.memoryIndexBlock);
  return parts.join("\n\n");
}

export function renderMemoryBody(entry: CirceMemoryBodyView): string {
  return [
    `Recalled ${entry.kind} (source ${entry.source}, updated ${entry.updatedAt}, id ${entry.id}): ${entry.title}`,
    entry.body,
  ].join("\n");
}
