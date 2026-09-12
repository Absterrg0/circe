/** Shared pending-clarification decisions for web, mobile, and desktop. */
export function isJarvisClarificationDiscard(answer: string): boolean {
  const normalized = answer
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return /^(?:no(?: thanks)?|none|cancel(?: it| that| this)?|discard(?: it| that| this)?|never ?mind|forget it|stop)$/u.test(
    normalized,
  );
}

const normalizeClarificationText = (value: string): string =>
  value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const stripPossessive = (normalized: string): string =>
  normalized.endsWith(" s") ? normalized.slice(0, -2).trim() : normalized;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  // Common ASR homophones for a bare spoken ordinal. This parser only runs
  // while a clarification is pending, so a lone "to" or "won" is an answer,
  // never a fresh instruction.
  won: 1,
  two: 2,
  to: 2,
  too: 2,
  three: 3,
  four: 4,
  for: 4,
  fore: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  ate: 8,
  nine: 9,
  ten: 10,
};

const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

/** Spoken position in a pending-clarification list, as a zero-based index. */
export function resolveJarvisClarificationOrdinal(answer: string): number | undefined {
  const normalized = normalizeClarificationText(answer);
  if (normalized.length === 0) return undefined;
  const prefixed = /^(?:the\s+)?(?:number|option|project|choice|task)\s+(.+)$/u.exec(
    normalized,
  )?.[1];
  const core = prefixed ?? normalized;
  const digits = /^(?:the\s+)?(\d+)(?:st|nd|rd|th)?(?:\s+one)?$/u.exec(core)?.[1];
  if (digits !== undefined) {
    const position = Number(digits);
    return Number.isSafeInteger(position) && position >= 1 ? position - 1 : undefined;
  }
  const word =
    /^(?:the\s+)?(one|won|two|to|too|three|four|for|fore|five|six|seven|eight|ate|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+one)?$/u.exec(
      core,
    )?.[1];
  if (word === undefined) return undefined;
  const position = NUMBER_WORDS[word] ?? ORDINAL_WORDS[word];
  return position === undefined ? undefined : position - 1;
}

export type JarvisClarificationCandidate = {
  readonly label: string;
  readonly names: ReadonlyArray<string>;
};

/**
 * Pending-clarification answer choice. A parsed ordinal selects by position
 * and is rejected when outside the candidate list; otherwise an exact
 * possessive-stripped name must match exactly one candidate.
 */
export function resolveJarvisClarificationChoice<Candidate extends JarvisClarificationCandidate>(
  candidates: ReadonlyArray<Candidate>,
  answer: string,
): Candidate | undefined {
  const ordinal = resolveJarvisClarificationOrdinal(answer);
  if (ordinal !== undefined) {
    return ordinal < candidates.length ? candidates[ordinal] : undefined;
  }
  const stripped = stripPossessive(normalizeClarificationText(answer));
  if (stripped.length === 0) return undefined;
  const matches = candidates.filter((candidate) =>
    candidate.names.some((name) => stripPossessive(normalizeClarificationText(name)) === stripped),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Numbered candidate list for spoken re-prompts. Bounded to the presented
 * candidates (at most five) so a voice answer can always name a number.
 * Returns the prompt unchanged when there are no choices.
 */
export function formatJarvisClarificationPrompt(
  prompt: string,
  choices: ReadonlyArray<string> | undefined,
): string {
  const trimmed = prompt.trim();
  if (choices === undefined || choices.length === 0) return trimmed;
  const numbered = choices
    .slice(0, 5)
    .map((choice, index) => `${index + 1}. ${choice}`)
    .join("  ");
  return `${trimmed} ${numbered}`;
}

export type JarvisClarificationRestart =
  | { readonly kind: "restart" }
  | { readonly kind: "replace"; readonly utterance: string };

/**
 * Explicit escape out of a pending clarification. `start over` clears the
 * pending question; `new instruction: ...` clears it and routes the
 * replacement text as fresh work. Explicit corrections also replace the request;
 * unmatched speech never silently becomes a new instruction.
 */
export function extractJarvisClarificationRestart(
  answer: string,
): JarvisClarificationRestart | undefined {
  const normalized = normalizeClarificationText(answer);
  if (normalized === "start over") return { kind: "restart" };
  const raw = answer.trim();
  const replacement = (
    /^(?:new|fresh)\s+instruction\s*:?\s*(.+)$/isu.exec(raw)?.[1] ??
    /^(?:actually|instead|never\s*mind)(?:\s*[,;:]\s*|\s+)(.+)$/isu.exec(raw)?.[1]
  )?.trim();
  if (replacement !== undefined && replacement.length > 0) {
    return { kind: "replace", utterance: replacement };
  }
  if (/^(?:new|fresh)\s+instruction\s*:?$/iu.test(raw)) return { kind: "restart" };
  return undefined;
}
