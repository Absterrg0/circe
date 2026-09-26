/**
 * A goal that names exactly one control to click. These goals do not need a
 * step model: the grounded surface either offers one unique match or the
 * deterministic path declines and the ordinary mission loop takes over.
 *
 * The parser is deliberately strict: any second action, sequence, or content
 * goal disqualifies the goal, because only single-action goals are safe to
 * complete without judgement.
 */

const SINGLE_CLICK_PATTERN =
  /^\s*(?:please\s+)?(?:click|press|tap|hit|select)\s+(?:on\s+)?(?:the\s+|a\s+|an\s+)?(.+?)\s*[.!]?\s*$/i;

const MULTI_STEP_CUES = [
  /\bthen\b/i,
  /\bafter that\b/i,
  /\band\b/i,
  /\btype\b/i,
  /\benter\b/i,
  /\bsearch\b/i,
  /\bdrag\b/i,
  /\bscroll\b/i,
  /\bwait\b/i,
  /\bclose\b/i,
  /\bopen\b/i,
  /\bgo to\b/i,
  /\bcheck\b/i,
  /\buncheck\b/i,
  /[,;]/,
];

const TRAILING_DESCRIPTORS = [
  " button",
  " icon",
  " link",
  " tab",
  " item",
  " entry",
  " field",
  " menu",
  " option",
];

/**
 * The control name a single-click goal names, or undefined when the goal is
 * not a single click. "click the 7 button in the calculator" -> "7".
 */
export function singleClickTarget(goal: string): string | undefined {
  const match = SINGLE_CLICK_PATTERN.exec(goal);
  if (match === null) return undefined;
  const target = match[1]?.trim();
  if (target === undefined || target.length === 0 || target.length > 80) return undefined;
  if (MULTI_STEP_CUES.some((cue) => cue.test(target))) return undefined;
  let name = target.toLowerCase();
  // Words like "in the calculator" name the app or window, not the control.
  const inClause = name.search(/\s+(?:in|on|from)\s+the\s+/);
  if (inClause > 0) name = name.slice(0, inClause).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const descriptor of TRAILING_DESCRIPTORS) {
      // Keep a descriptor only when it is the entire name.
      if (name.endsWith(descriptor) && name.length > descriptor.length) {
        name = name.slice(0, -descriptor.length).trim();
        changed = true;
      }
    }
  }
  return name.length === 0 ? undefined : name;
}
