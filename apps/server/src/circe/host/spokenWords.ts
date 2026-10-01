/**
 * Speech-to-text marks sounds that are not words, such as "[clears throat]"
 * or "(coughs)", sometimes without the closing bracket. Circe must not read
 * them as a request. Only a bracketed or starred segment that names a sound is
 * removed, so a typed message that uses brackets keeps them.
 */
const SOUND =
  "(?:clears?|clearing)\\s+(?:(?:his|her|their|my)\\s+)?throat|cough\\w*|laugh\\w*|chuckl\\w*|sigh\\w*|sniff\\w*|sneez\\w*|breath\\w*|inhal\\w*|exhal\\w*|yawn\\w*|groan\\w*|hum(?:s|ming)?|mumbl\\w*|inaudible|unintelligible|silence|blank[_ ]audio|no speech|music|applause|noise|background noise|static|typing|click\\w*|keyboard\\w*";

const SOUND_MARK = new RegExp(
  [
    `\\[\\s*(?:${SOUND})[^\\]]*(?:\\]|$)`,
    `\\(\\s*(?:${SOUND})[^)]*(?:\\)|$)`,
    `\\*\\s*(?:${SOUND})[^*]*(?:\\*|$)`,
  ].join("|"),
  "giu",
);

/** The words the user said, without sound marks; empty when there were none. */
export function spokenWords(utterance: string): string {
  return utterance.replace(SOUND_MARK, " ").replace(/\s+/gu, " ").trim();
}
