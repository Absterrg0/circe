# Circe design system

The brand book. Tokens live beside it in `tokens.css` and `tokens.json`; logos in `logos/`. Where the shipped app departs from this book, [docs/internals/circe-design-system.md](../../docs/internals/circe-design-system.md) records the decision and why.

Circe is one assistant for directing coding agents across all your machines. The interface is warm near-black with copper as its one accent. Layout and type carry the screen: surfaces stay matte and quiet, and anything that glows is either working or waiting on you.

## Principles

1. **Light means alive.** Glow (`glow-ember`, `glow-attention`, `glow-voice`) marks exactly three things: work that is running, work that is waiting on the user, and Circe listening. Nothing decorative glows. If two things on screen glow gold, one of them is wrong.
2. **Heat means urgency.** The warmer and brighter the colour, the sooner it needs a person: `ink-faint` for settled work, `ember` for running work, `attention` (the gold core of the mark) for work that needs you.
3. **Every task names its machine.** A task row, card, toast or spoken report always carries its node (`@forge`, a `NodeChip`, "on studio"). Work never appears without the place it runs.
4. **Circe asks; it never guesses.** Ambiguity gets a `Clarify` card, a pending tool gets an `ApprovalCard`. Both are typed components with their own colour, never a line of chat text.
5. **Space, not boxes.** Group with space and a hairline. Lists sit on the canvas as rows. A surface (`raised`) is earned only by things you act on: the composer, an approval, a menu. Never a card inside a card, never a box around a table, never a number without a reason to read it.
6. **Desktop first, then mobile, then web.** The rail and the voice bar are designed for the Electron app. Mobile gets the same tokens with larger targets. A browser tab gets whatever the desktop layout gives it.

## Content

- **Operational and short.** Say what happened, where, and what is next: "forge finished. 2 files changed, 50 of 50 test runs pass." Not "Great news! Your task was completed successfully."
- **Machine names are lowercase and literal**: `studio`, `forge`, `pi-lab`. Never "your MacBook" unless the node is named that.
- **Status words are fixed**: Running, Queued, Needs you, Completed, Failed, Offline, Settled. Use them verbatim in badges, sections and speech.
- **In progress ends with an ellipsis** (the single character …): "Finding your machines…", "Opening “Fix flaky token refresh test” on forge…".
- **Disconnects say what Circe did not do**: "Offline 12 min. 1 task paused here; Circe will not move it." Never imply work moved silently.
- **Sentence case everywhere.** Uppercase belongs only to instrument labels (the `label` style), which carry a few words each: NEEDS YOU, RUNNING, CODEX · WEEKLY.
- **No mystical verbs.** Not summoning, casting, conjuring or magic. Circe opens, runs, asks, reports.
- **"You" for the person, "I" for the agent's own prose.** Circe's system copy stays impersonal ("Two tasks need you.").
- **No emoji** in product copy or agent chrome.

## Colour

Two themes: **Void** (`dark`, the default, warm near-black) and **Daylight** (`light`, warm paper). Both keep the rail and the voice bar on `orb-void`, so the mark and the orb always sit on black. Components that must stay dark render with `data-theme="dark"` on their root, which re-scopes every token inside them.

**Surfaces, back to front:** `rail` → `chrome` (window ground, inset sidebar) → `canvas` (the inset main panel) → `raised` (the composer, approvals, inputs) → `overlay` (menus, palette, toasts). `well` is recessed: code, terminals, meter tracks. The steps are small on purpose; most content needs no surface at all.

**Ink:** `ink` for primary text, `ink-muted` for secondary text and resting icons, `ink-faint` for placeholders, timestamps and directory parts of paths. All three pass 4.5:1 on every surface in both themes; `ink-faint` is not for text on coloured fills.

**Action:** `ember` is copper, the same light as the orb, and the only action colour: primary buttons, focus rings, links (`link` aliases it) and running work. Text on an ember fill is `on-ember`. Hover and pressed use `ember-strong`. One primary button per view.

**Signals:**

| Token       | Means                                                    | Pair with                                          |
| ----------- | -------------------------------------------------------- | -------------------------------------------------- |
| `attention` | Needs you: approvals, questions, clarifications          | `attention-soft`, `on-attention`, `glow-attention` |
| `voice`     | Anything spoken: listening, transcripts, spoken reports  | `voice-soft`, `glow-voice`                         |
| `success`   | Completed, online, added lines                           | `success-soft`                                     |
| `danger`    | Failed, disconnected, removed lines, destructive actions | `danger-soft`                                      |

Success is a sage that leans toward teal, so it separates from `danger` by more than red and green. Every status also carries a glyph and a word (`Status`, `StatusGlyph`); colour is never the only signal.

**Orb colours** (`orb-void`, `orb-core`, `orb-deep`, `orb-copper`, `orb-peach`, `orb-hot`) come from the mobile orb's palette. They belong to the orb, `gradient-voice` and `gradient-horizon` only. Never set text or a button in an orb colour.

**Gradients:** `gradient-voice` for the listening waveform and the voice bar's bottom line. `gradient-horizon` only behind the orb on the mobile voice screen. No other gradients in UI.

## Type

- **Sora** (`display`) carries the wordmark's round geometry. Use it for `display-xl` (the greeting, once per screen), `display` (page titles), `title` (dialog and card titles) and `label`, the tracked uppercase instrument label that heads sections, meters and the voice bar.
- **Onest** (`sans`) sets everything a person reads or clicks: `heading`, `body` for prose and prompts, `ui` for buttons, rows and tabs, `small` for metadata, `caption` for badges. Its word spacing holds at 12px and on React Native, where word-spacing cannot be patched.
- **JetBrains Mono** (`mono`) sets anything a machine wrote or will read: `code` for commands and code, `code-sm` for paths, terminal output, addresses and keycaps. Paths split into `ink-faint` directories and an `ink` file name.
- Numbers that change in place (counts, meters, diff stats, times) use `font-variant-numeric: tabular-nums`.
- Never set paragraphs in Sora or UI labels in mono.

## Layout: rail, inset sidebar, canvas

The desktop shell is three columns (`AppShell`):

1. **Rail** (`rail-width`, 64px). Always Void. Top to bottom: the mark (opens the overview), destinations (Tasks, Agents, Pull requests, Scheduled, Usage), a rule, one tile per machine (the layers tile means all machines; the scoped tile gets a ring), a dashed tile to pair a machine, then search, the mic (it lights in `voice` while Circe listens), settings and the account. The gold count on Tasks is the number of tasks that need you.
2. **Inset sidebar** (`sidebar-width`, 280px, resizable 240 to 400). Sits on `chrome` and shows whatever the rail points at: tasks grouped as Needs you, Running, Today; agents; pull requests. Its header row is `topbar-height` and aligns with the canvas header. ⌘B collapses it to rail only.
3. **Canvas.** An inset panel on `canvas` with a `line` border, `radius-xl` corners and `canvas-gap` (8px) from the window's top, right and bottom. The timeline and composer centre in `content-max` (760px). The overview runs rail only: a header bar, then a main column (headline, a stat line, the composer, Needs you, Activity) and a 360px side column (Machines, Limits) split by a hairline.

On mobile the rail becomes the `TabBar` (Home, Tasks, Library) and the machine tiles become the "All machines" scope chip. Hit areas are at least `touch-min`.

## Spacing, radii and elevation

- A 4px grid. `space-2` inside controls, `space-3` for row padding, `space-4` for cards, `space-5` between timeline items, `space-6` gutters, `space-10` between canvas sections.
- Controls are `control-sm` (28), `control-md` (32) or `control-lg` (40) tall. Rows are `row-height` (32); task rows are two lines.
- Radii are precise, not bubbly: `radius-sm` chips and badges, `radius-md` buttons, inputs and rows, `radius-lg` cards and the composer, `radius-xl` the canvas, dialogs, palette and voice bar. `radius-full` is reserved for things that are present or alive: the orb, presence dots, status glyphs.
- Elevation is `shadow-sm` for the few raised surfaces and `shadow-lg` for anything floating. In Void, `shadow-sm` includes a 1px top highlight instead of a darker drop.
- The selected row lifts (`row-selected` plus `shadow-sm`). Never mark selection with a coloured left stripe.

## Glow and state

| State     | Treatment                                                                                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running   | `ember` glyph (an orbiting dot), `ember-soft` badge, `glow-ember` on the send button when there is something to send, a 1px ember hairline on a busy machine's card |
| Needs you | `attention` glyph with a halo, `glow-attention` on the approval card, the gold rail count                                                                           |
| Listening | `voice` everywhere: the mic button (`glow-voice`), the composer border, the waveform, the clarify card                                                              |
| Focus     | `focus-ring`: a 2px `canvas` gap, then 2px of solid `ember`. At least 3:1 on every surface; the rail uses the same ring with a `rail` gap                           |
| Disabled  | 45% opacity, no glow, cursor not-allowed                                                                                                                            |

## Motion

- 120ms for hover and press, 200ms for panels and chevrons, 320ms for large surfaces, all on `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Move with opacity, a 4 to 8px translation or a 0.97 to 1 scale. No springs, no parallax.
- Loops run only while something is alive: the running glyph (12 steps a turn), the orb while listening, working or speaking, the waveform while listening. Loops use stepped timing so the compositor draws a handful of frames, not one per vsync.
- Under `prefers-reduced-motion: reduce` every loop stops and the listening halo holds still.
- A disabled voice client shows the orb in its `offline` state and runs nothing.

## The orb

`Orb` is Circe's presence while it is **talking with you**, and only then: the desktop voice bar, the full-screen voice view on mobile, and nowhere else. It is dark glass with copper light on its rim, ported from the mobile orb shader. It is never decoration, never a hero, never on the overview, and never in the rail (the mic button shows voice state there).

States: `listening` (the rim turns slowly, the bloom swells), `working` (faster), `speaking` (a slow pulse), `attention` (gold halo, when voice needs you to pick), `error` (desaturated, danger halo), `idle` and `offline` for completeness. Pair it with visible state text.

## Voice

The desktop voice bar (`VoiceBar`) floats over whatever app is in front, always in Void. It shows the orb, an instrument label for the state (LISTENING in `voice`, WORKING in `ember`, SPEAKING in `orb-peach`, WHICH ONE? in `attention`), the live transcript with matched names in `voice`, and the key to release. When a name matches more than one task it expands into a `Clarify` card: numbered options with their project and machine, answered by saying or pressing the number, dismissed with esc. Spoken reports appear in the timeline as a `voice-soft` chip: "Spoken on studio · 0:14".

## Iconography

- Lucide icons at `strokeWidth` 1.5: 16px in buttons and rows, 19px in the rail, 22px in the mobile tab bar. The `Icon` component carries the set the product uses; the Icon card lists it.
- Icons are functional. Pair an icon with text unless the control has a tooltip and an `aria-label`.
- Status glyphs are Circe's own (the Icons asset group): an orbiting dot for running, a dashed ring for queued, a haloed gold dot for needs you, filled check and cross for completed and failed, a struck ring for offline, a small dot for settled, three bars for speaking.
- Providers appear as two-letter monogram tiles (`ProviderMark`: Cx, Cl, Cu, Gk, Oc) in UI chrome. Provider logos belong in provider settings only.
- No sparkles, robots-as-decoration or wands. The rail's Agents destination uses Lucide `bot` as a label, nothing more.

## The logo

- The mark and wordmark come from the brand board in the Logos group. Never redraw, recolour, rotate or re-light the mark.
- `logos/circe-mark.png` goes only on `orb-void` or `rail`: its glow is transparent light and washes out on light grounds. On any light surface use `circe-app-icon.png`, which carries its own void tile.
- The wordmark is `circe-wordmark-light.png` on dark grounds and `circe-wordmark-dark.png` on light ones. Stack it under the mark with the tagline "One assistant. All your machines." only in brand moments (splash, about, marketing).
- Keep clear space of half the mark's width on every side. The smallest mark is 20px; below that use `circe-favicon.png`.
- `circe-mark-mono.png` is for places that cannot show colour: print, system tray templates, watermarks.

## Accessibility

- Text meets 4.5:1 on its named grounds in both themes; control borders (`line-strong`), focus rings and meaningful icons meet 3:1. `line` is decorative and may be fainter.
- Every status pairs colour with a glyph and a word. Success and danger differ by hue family (teal vs red), not red versus green.
- Every icon-only control has an `aria-label` and a tooltip with its shortcut.
- Approval cards show the full command, wrapped, never truncated. A person cannot approve what they cannot read.
- Voice never becomes the only path: every clarify option is clickable and numbered, every approval has buttons and a shortcut.
