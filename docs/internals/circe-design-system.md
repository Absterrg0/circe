# Circe design system

The design lives in [`assets/circe/design-system.md`](../../assets/circe/design-system.md), with tokens in `assets/circe/tokens.css` and logos in `assets/circe/logos/`. This page records how the clients implement it, where they deliberately depart from it, and the traps that are not obvious from the code.

## One palette, three owners

The stock palette (Void in dark, Daylight in light) is written in three places that must agree:

- **Web and desktop:** the first `:root` block in `apps/web/src/index.css`. `CIRCE_CODE_*_THEME_COLORS` in `apps/web/src/themePalette.ts` repeat it to seed new themes, and `apps/web/index.html` and `apps/desktop/src/window/DesktopWindow.ts` repeat the chrome color so the first frame does not flash.
- **Mobile:** `apps/mobile/global.css` is authored; `vp run --filter @circe/mobile generate` derives the runtime JSON and the generated theme CSS from it. The static `--color-circe-*` block in `createMobileThemeVariables` must match it so named themes carry the same signal tokens.
- **Previews:** `STANDARD_THEME_PREVIEW_COLORS` in `packages/shared/src/themePreview.ts` is the one source both the web and mobile theme pickers read.

Tests pin each copy against its source rather than against hex literals where they can.

## Design tokens are aliases of theme roles

The design names (`--ember`, `--attention`, `--canvas`, `--ink`, `--line`) are declared in a second `:root` block as aliases of the semantic roles (`--primary`, `--warning`, `--background`, `--contrast-foreground`, `--contrast-border`). A user theme only sets roles, so aliasing is what lets Circe surfaces follow a named theme; declaring the design values directly would freeze the rail, glyphs and overview in Void while the rest of the app changed. Glows are `color-mix` of the role colors for the same reason. `--voice` and the orb colors are Circe's own and do not follow themes; the rail re-scopes its tokens to Void locally.

Tailwind v4 reads `--shadow-*` and `--radius-*` as theme variables, so the design's shadows are named `--elevation-sm` and `--elevation-lg` to avoid rewriting every `shadow-sm` in the app. The radii are set to the design's steps (6, 8, 12, 16) on purpose.

## Where the app departs from the book

- **Appearance follows the OS.** The book makes Void the default; the app keeps the existing system-follow default so a light-desktop user is not forced dark.
- **One gold glow.** The book's own rule ("if two things glow gold, one is wrong") conflicts with its overview mock, where every Needs you row glows. Only the first Needs you row, and the approval drawer when one is open, carries `--glow-attention`.
- **Sidebar sections.** The book groups the task list as Needs you, Running, Today. The app keeps its Pinned, Active, Snoozed and Settled shelves because pinning, settling and snoozing are real user actions with server state; heat is carried by the row's status glyph instead.
- **Approvals open the task.** The overview's Needs you rows offer Review or Answer rather than inline Allow and Deny, because the full request must be readable before approving and the row has no room for it. The approval drawer in the task follows the book's ApprovalCard.
- **Desktop voice stays an orb.** The book's VoiceBar is a horizontal strip. The desktop overlay keeps its draggable orb and activity panel, with its window geometry and snapping, and takes the book's palette: copper light on dark glass, voice, ember and attention for state.
- **The mobile home keeps its orb.** Home and the voice view are one scene around one orb that animates between them. The book's "no orb on the overview" applies to the desktop overview, where the orb was a decorative hero.
- **Machine tiles.** With a single machine the rail tile shows its machine icon instead of a two-letter monogram, and there is no account avatar because a node has no single account.

## Shell

The rail is an in-flow column; the shadcn sidebar container is `position: fixed`, so `circe-shell.css` offsets it by `--rail-width` and slides it under the rail when collapsed. The rail replaces the floating sidebar toggle on desktop, so `--workspace-titlebar-content-left` is overridden there; on macOS the traffic lights sit over the rail, whose top padding clears them. The overview hides the sidebar with CSS rather than unmounting it, so the task list keeps its search, drag and scroll state.

## Motion and cost

Every loop is stepped (`steps(n)`) so the compositor draws a handful of frames per cycle, and stops under `prefers-reduced-motion`. The web orb animates only while listening, working or speaking. The desktop overlay's WebGL orb stops drawing two seconds after it settles into idle. Fonts are bundled (`@fontsource-variable/*` on web, `@expo-google-fonts/*` on mobile) and mobile registers them natively in `app.config.ts`; Hermes has no `Array#toSorted`, which the mobile lint rule catches.
