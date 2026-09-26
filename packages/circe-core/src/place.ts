import { circeWebsiteUrl } from "./website.ts";

/**
 * Place candidates are transcript spans, never language patterns. Code only
 * splits the utterance into maximal runs of non-vocabulary tokens (a run may
 * start with an article, so "the hague" stays whole); the decision tier selects
 * the run the user named; the lookup then grounds that selection back into the
 * transcript. Casing, accents, filler words, and word order stay the model's
 * job, so voice keeps working without a place grammar that would age badly.
 *
 * Shared by the classifier and the quick lookup so a spoken answer to "which
 * place?" ("in London", "it's London") yields the same bounded span.
 */

const LOCATION_TOKEN_PATTERN = /[\p{Letter}\p{Number}][\p{Letter}\p{Number}.'-]*/gu;
const LEADING_ARTICLE = /^(?:the|a|an)$/u;

const fold = (value: string): string => value.trim().toLowerCase();

const placeWordKey = (word: string): string =>
  word.toLowerCase().replace(/[^\p{Letter}\p{Number}]/gu, "");

/**
 * Words that are never part of a place name the user would answer with: question
 * vocabulary, command verbs, day words, and connectives. A bare phrase made only
 * of these is a question or an instruction, not a place.
 */
const NON_PLACE_WORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "actually",
  "add",
  "an",
  "and",
  "are",
  "at",
  "build",
  "can",
  "cancel",
  "check",
  "close",
  "commit",
  "compare",
  "could",
  "create",
  "current",
  "currently",
  "day",
  "days",
  "deploy",
  "do",
  "does",
  "document",
  "examine",
  "fetch",
  "find",
  "fix",
  "focus",
  "for",
  "forecast",
  "from",
  "get",
  "give",
  "hey",
  "how",
  "hows",
  "i",
  "implement",
  "in",
  "investigate",
  "is",
  "it",
  "just",
  "kind",
  "like",
  "list",
  "look",
  "maybe",
  "me",
  "merge",
  "move",
  "my",
  "near",
  "next",
  "now",
  "of",
  "ok",
  "okay",
  "on",
  "open",
  "or",
  "pause",
  "play",
  "please",
  "previous",
  "pull",
  "push",
  "queue",
  "really",
  "rebase",
  "remove",
  "resume",
  "reroute",
  "review",
  "right",
  "run",
  "search",
  "set",
  "show",
  "skip",
  "so",
  "sort",
  "start",
  "status",
  "stop",
  "switch",
  "task",
  "tell",
  "temperature",
  "temps",
  "test",
  "that",
  "the",
  "then",
  "there",
  "this",
  "tighten",
  "time",
  "to",
  "today",
  "tomorrow",
  "tonight",
  "uh",
  "um",
  "update",
  "us",
  "weather",
  "we",
  "week",
  "well",
  "what",
  "whats",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "would",
  "write",
  "you",
]);

export function extractLocationCandidates(source: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const add = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || candidates.length >= 8) return;
    const key = fold(trimmed);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };
  const tokens: string[] = [];
  const pattern = new RegExp(LOCATION_TOKEN_PATTERN.source, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) tokens.push(match[0]);
  let run: string[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    add(run.join(" "));
    run = [];
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const key = placeWordKey(token);
    if (NON_PLACE_WORDS.has(key)) {
      // An article may open a run only when a real name word follows it, so
      // "the hague" stays whole and a stray "the" never becomes a candidate.
      if (run.length === 0 && LEADING_ARTICLE.test(key)) {
        const next = tokens[index + 1];
        const nextKey = next === undefined ? undefined : placeWordKey(next);
        if (
          nextKey !== undefined &&
          !NON_PLACE_WORDS.has(nextKey) &&
          !LEADING_ARTICLE.test(nextKey)
        ) {
          run.push(token);
          continue;
        }
      }
      flush();
      continue;
    }
    run.push(token);
    if (run.length >= 5) flush();
  }
  flush();
  return candidates.filter((candidate) => circeWebsiteUrl(candidate, source) === null);
}
