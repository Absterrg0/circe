/**
 * Deterministic app resolution for desktop missions.
 *
 * A goal like "click Recent Files in the file manager" must bind to the app
 * the user named, not to whatever window happens to be foreground. The model
 * then sees a bounded surface for that app instead of every window on the
 * desktop. Matching is code-side and closed: a goal only ever resolves to an
 * app that is actually running and that the alias table names.
 */

const APP_ALIASES: ReadonlyArray<{ readonly match: ReadonlyArray<string>; readonly app: string }> =
  [
    { match: ["file manager", "files", "nautilus"], app: "nautilus" },
    { match: ["calculator", "calc"], app: "calculator" },
    { match: ["text editor", "editor", "notes"], app: "text editor" },
    { match: ["browser", "chrome", "chromium", "google chrome"], app: "chrome" },
    { match: ["firefox"], app: "firefox" },
    { match: ["terminal", "console"], app: "terminal" },
    { match: ["settings", "control center"], app: "settings" },
  ];

/** Case- and separator-insensitive fold so "gnome-text-editor" matches "text editor". */
const fold = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * The running app the goal names, or undefined when the goal names none or
 * names one that is not running. `appNames` are the names the observation
 * reported; the returned value is one of them.
 */
export function resolveDesktopApp(
  goal: string,
  appNames: ReadonlyArray<string>,
): string | undefined {
  const text = fold(goal);
  if (text.length === 0 || appNames.length === 0) return undefined;
  // An app's own name always wins: "open the calculator" against an app named
  // "gnome-calculator" resolves by containment before any alias table.
  for (const name of appNames) {
    const folded = fold(name);
    if (folded.length >= 3 && text.includes(folded)) return name;
  }
  for (const entry of APP_ALIASES) {
    if (!entry.match.some((alias) => text.includes(alias))) continue;
    for (const name of appNames) {
      if (fold(name).includes(entry.app)) return name;
    }
  }
  return undefined;
}

/**
 * Keep the elements of one app plus the window frames, so the model can still
 * focus the app's window but cannot act on unrelated windows.
 */
export function scopeSurfaceToApp<
  E extends { readonly app?: string | undefined; readonly role: string | null },
>(elements: ReadonlyArray<E>, app: string): ReadonlyArray<E> {
  const folded = fold(app);
  return elements.filter(
    (element) =>
      element.app === undefined ||
      fold(element.app).includes(folded) ||
      folded.includes(fold(element.app)),
  );
}

/** Tokens too common to indicate which control a goal names. */
const GOAL_STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "in",
  "on",
  "at",
  "to",
  "of",
  "for",
  "with",
  "my",
  "this",
  "that",
  "then",
  "click",
  "press",
  "type",
  "open",
  "item",
  "please",
  "desktop",
  "screen",
  "window",
]);

const goalTokens = (goal: string): ReadonlyArray<string> =>
  fold(goal)
    .split(" ")
    .filter((token) => token.length >= 3 && !GOAL_STOPWORDS.has(token));

const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  "push button",
  "button",
  "list item",
  "entry",
  "text",
  "link",
  "menu item",
  "check box",
  "radio button",
  "tab",
  "page tab",
  "toggle button",
  "combo box",
  "slider",
  "spin button",
]);

/**
 * Bound a surface to the elements most likely to satisfy the goal. The step
 * model selects among these, so a small decision model sees the controls the
 * goal actually names instead of every node in the app. The app's frames are
 * always kept so the model can focus the window.
 */
export function rankSurfaceForGoal<
  E extends {
    readonly id: string;
    readonly role: string | null;
    readonly name: string;
    readonly app?: string | undefined;
  },
>(elements: ReadonlyArray<E>, goal: string, limit = 24): ReadonlyArray<E> {
  const tokens = goalTokens(goal);
  if (tokens.length === 0 || elements.length <= limit) return elements;
  const scored = elements.map((element, index) => {
    const name = fold(element.name);
    const role = fold(element.role ?? "");
    let score = 0;
    for (const token of tokens) {
      if (name.includes(token)) score += 3;
      if (role.includes(token)) score += 1;
    }
    if (ACTIONABLE_ROLES.has(role)) score += 2;
    if (role === "frame" || role === "window") score += 1;
    return { element, index, score };
  });
  scored.sort((left, right) =>
    right.score === left.score ? left.index - right.index : right.score - left.score,
  );
  // Frames stay: the model may need to focus the window before acting.
  const frames = elements
    .filter((element) => {
      const role = fold(element.role ?? "");
      return role === "frame" || role === "window";
    })
    .slice(0, 2);
  const ranked = scored
    .filter((entry) => !frames.includes(entry.element))
    .slice(0, Math.max(1, limit - frames.length))
    .map((entry) => entry.element);
  return [...frames, ...ranked];
}
