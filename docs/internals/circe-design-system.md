# Circe design system v1.0

Source of truth for Circe UI, product screenshots, marketing surfaces, and generated mockups. Circe should feel calm, capable, warm, focused, premium, operational, and device-agnostic.

Machine-readable tokens live in `assets/circe/tokens.json` and `assets/circe/tokens.css`. Logo masters live in `assets/circe/` with usage notes in `assets/circe/logo-assets-readme.md`. The agent checklist lives in `assets/circe/agent-prompt.md`. When this page and those files disagree, the files win and this page must be updated to match.

## 1. Brand intent

Circe is a quiet control plane for work across machines.

It should feel calm (low visual noise, generous whitespace, restrained hierarchy), capable (operational, trustworthy, precise), warm (one orange accent on neutral charcoal, never cold blue SaaS), focused (every control must earn its place), and everywhere (consistent across desktop, mobile, voice, and control-center surfaces).

Primary lines: "Your work. Everywhere.", "Think. Do. Across your machines.", "A more capable you."

Avoid mystical language, cyberpunk styling, purple and blue AI gradients, glowing robots, sparkles, magic motifs, excessive glassmorphism, and unnecessary decorative icons.

## 2. Logo usage

Use the approved Circe logo assets in `assets/circe/`.

Preferred lockups: horizontal logo for headers, desktop chrome, and website navigation; mark only for app icon, favicon, orb, avatar, and compact surfaces; stacked lockup for editorial and brand compositions only.

Rules: never distort, rotate, stretch, bevel, outline, or recolor the logo arbitrarily. Preserve clear space around the mark equal to at least 0.5x the mark width. On light surfaces use the dark wordmark; on dark surfaces use the white wordmark. The warm gradient mark stays consistent in both modes.

## 3. Brand palette

| Token         | Hex       | Use                                      |
| ------------- | --------- | ---------------------------------------- |
| `snow`        | `#FAFAFA` | Primary light background                 |
| `charcoal`    | `#111113` | Primary dark background                  |
| `ink`         | `#0C0C0D` | Dark chrome: sidebar, title bar, splash  |
| `graphite`    | `#18181A` | Dark cards and raised surfaces           |
| `zinc`        | `#E4E4E7` | Light borders and muted surfaces         |
| `orange`      | `#F26B3A` | Brand accent: focus, indicators, the orb |
| `orange-deep` | `#CC4A14` | Light-mode fills under white text        |
| `peach`       | `#FFA47A` | Highlight and gradient endpoint          |
| `ember`       | `#4A1A0A` | Orb and gradient depth                   |

Brand gradient: `linear-gradient(135deg, #4A1A0A 0%, #A8401A 38%, #F26B3A 68%, #FFA47A 100%)`. Use it for the voice orb, signature brand moments, and hero imagery. Do not use it as the default fill for buttons, cards, or navigation.

## 4. Semantic color tokens

Light mode: `bg` `#FAFAFA`, `surface-1` `#FFFFFF`, `surface-2` `#F4F4F5`, `surface-3` `#EEEEF0`, `text-primary` `#18181B`, `text-secondary` `#63636B`, `text-muted` `#8A8A92`, `border` `#E4E4E7`, `border-strong` `#D4D4D8`, `accent` `#CC4A14`, `accent-hover` `#B53F0F`, `accent-soft` `#FDEEE6`, `success` `#3FA36F`, `warning` `#D89545`, `danger` `#D9515D`, `info` `#667C96`.

Dark mode: `bg` `#111113`, `surface-1` `#18181A`, `surface-2` `#1E1E21`, `surface-3` `#222225`, `text-primary` `#F5F5F4`, `text-secondary` `#A1A1A6`, `text-muted` `#7D7D83`, `border` `#262629`, `border-strong` `#38383C`, `accent` `#F26B3A`, `accent-hover` `#FF7D4D`, `accent-soft` `#2A1C16`, `success` `#4CC38A`, `warning` `#E7AA5A`, `danger` `#EF6873`, `info` `#8FA4BD`.

## 5. Typography

Product UI is Inter (`Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`), weights 400 body, 500 labels and controls, 600 headings, 700 rare major emphasis only. Brand and editorial is Satoshi with Inter fallback; a restrained serif may be used for large display headings in marketing and editorial compositions only, never inside dense product UI.

Type scale: Display XL 48 to 64px at 500, Display L 40 to 48px at 500, H1 32px at 600, H2 24px at 600, H3 18px at 600, Body L 16px at 400, Body 14px at 400, Small 12px at 400, Label 11 to 12px at 600, Micro 10 to 11px at 600. UI controls use sentence case; micro labels may use uppercase with letter spacing.

## 6. Spacing

4px base grid. Allowed: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80. Dense table rows and standard controls run 40 to 44px; mobile touch targets minimum 44px; card padding 16 to 24px; section separation 32 to 48px. Avoid arbitrary spacing unless technically necessary.

## 7. Radius

Circe feels soft, not bubbly. `radius-xs` 6px, `radius-sm` 8px, `radius-md` 12px, `radius-lg` 16px, `radius-xl` 22px, `radius-pill` 999px. Defaults: buttons and inputs 10 to 12px, cards 14 to 16px, floating surfaces 20 to 24px, pills only when semantically appropriate.

## 8. Borders and shadows

Prefer borders over heavy shadows. Light: 1px `#E4E4E7` border with `0 8px 28px rgba(24, 24, 27, 0.08)`. Dark: 1px `#262629` border with `0 12px 36px rgba(0, 0, 0, 0.4)`. Glow is reserved for the Circe orb, listening state, and small active brand indicators. Never glow entire cards or tables.

## 9. Icons

One icon family consistently (Lucide recommended on web; Tabler mapping on mobile): default 16 to 18px, large standalone controls 20 to 24px, stroke 1.5 to 1.75px. Icons are functional, not decorative. No unnecessary icons beside already-clear text, no generic AI sparkle icons. Use the Circe mark only when representing Circe itself.

## 10. Buttons

Primary: accent background, near-white text, 40 to 44px height, 12px radius, one dominant primary action per local context. Secondary: neutral surface, 1px border, primary text. Ghost: transparent, borderless until hover where appropriate. Destructive uses danger, never brand orange.

## 11. Inputs and command surfaces

Quiet and structural: 42 to 46px height, subtle border, slight surface contrast, muted placeholder, accent border plus restrained focus ring on focus. Command bars can be slightly pill-like but must not look like generic chat bubbles.

## 12. Cards and panels

Cards exist for grouping, not decoration. Hierarchy: background, then primary surface, then a nested surface only when needed. Default card is 14 to 16px radius, 1px border, little or no shadow. Avoid endless card-within-card nesting.

## 13. Navigation

Desktop: one left sidebar. Its top holds the destinations (Home, Pull requests, Machines, Usage) as labeled rows; below them sit search and the thread groups; Settings sits in the footer. The active item uses a neutral raised surface, not a filled accent. Home carries Circe's presence and the needs-you count, so there is no separate launcher. Mobile: 3 to 5 primary destinations max, never force device or project selection before user intent. The primary flow feels like telling Circe what you want.

## 14. Status colors

Running is accent orange, Completed is success, Queued is neutral gray, Failed is danger, Needs input is warning, Offline is muted gray. Always combine color with text or iconography. Progress bars are 4 to 6px with a neutral track and accent fill, no animated rainbow gradients.

## 15. Voice and listening state

A signature Circe moment: immersive dark surface, warm orb or ring, subtle waveform or flowing line, restrained bloom, direct state text (`Listening…`, `Thinking…`, `Working…`, `Done`). Attentive and deterministic, never mystical, never phone-call UI.

## 16. Motion

Micro interactions 120 to 180ms, panel transitions 180 to 240ms, modal and large surfaces 220 to 300ms, easing `cubic-bezier(0.2, 0.8, 0.2, 1)`. Prefer opacity, subtle 0.98 to 1 scale, and short 4 to 8px translations. No bouncy springs, exaggerated parallax, perpetual decorative motion, or spinning gradients.

## 17. Light mode

Near-white, not ivory. Page `#FAFAFA`, cards `#FFFFFF`, chrome `#F4F4F5`, zinc borders, charcoal type, orange only where it means something.

## 18. Dark mode

Neutral charcoal, not blue and not pure black. Background `#111113`, chrome `#0C0C0D`, cards `#18181A`, elevated surfaces `#1E1E21`. Avoid large fields of `#000000`.

## 19. Marketing imagery

Charcoal and near-white fields with orange illumination, soft architectural curves, editorial composition, generous negative space. Product UI stays the hero; background imagery supports rather than competes; use the logo sparingly; no robots, brains, circuit-board cliches, holograms, stars, wands, or generic AI motifs.

## 20. Accessibility

Body text contrast at least 4.5:1, large text at least 3:1, visible focus states, 44px minimum mobile touch targets, state never relies on color alone, support reduced motion, no faint gray body text on near-white.

## 21. Product principles

Circe is one assistant across many machines, not a device manager first. Never require manual device selection in the normal path, never lead with provider or model selection, hide infrastructure until relevant, user intent comes first, Circe resolves routing, device and execution detail appears progressively. Prefer operational language (`Running`, `Queued`, `Completed`, `Needs input`); never mystical language (`Working magic`, `Casting`, `Summoning`).

## 22. Anti-patterns

No purple-to-blue AI gradients, neon cyan, orange everywhere, glassmorphism everywhere, huge rounded pills, icons in every button, unnecessary badges, sparkle icons as filler, gradient text in dense UI, oversized shadows, random illustrations, duplicated icon-plus-text semantics, forcing project or device selection before action, or phone-call-like voice screens.

## 23. Agent implementation rule

When generating a new Circe screen: pick light or dark semantic tokens, use only defined spacing and radius tokens, use accent only for action, focus, or meaningful state, keep hierarchy quiet, remove decorative elements that do not improve comprehension. If the result looks like a generic SaaS dashboard, simplify it.

## Adoption note

The mobile app currently uses DM Sans where this system specifies Inter; switch to Inter via the Expo font plugin when touching the font stack. Mobile still carries the retired copper and midnight values in `apps/mobile/src/lib/mobileTheme.ts` and `app.config.ts`; move them to this palette in the mobile pass so both apps look like one product.

## Web implementation notes

The palette above is the web app's default: the base `:root` block in `apps/web/src/index.css` applies whenever no named theme is selected. `CIRCE_CODE_*_THEME_COLORS` in `apps/web/src/themePalette.ts` repeat the same values to seed new themes in the editor, and `apps/web/index.html` plus the desktop window's first paint repeat the chrome color so launch does not flash. Change them together.

White text on the brand orange `#F26B3A` measures about 3:1, below the 4.5:1 body-text minimum. Light mode therefore fills buttons with `#CC4A14` (4.6:1 with white). Dark mode fills with the brand orange under near-black text (6.3:1). The brand orange stays on focus rings, active indicators, and the orb in both modes.

The orb (`CirceOrb`) is the only animated brand element. It moves only while Circe is listening or working, uses stepped keyframes, and holds still under reduced motion.
