# Circe logo assets

The Prism Orbit mark and its wordmarks, cut from the approved brand board (`logos/circe-brand-board.webp`, the original). Never redraw, recolour, rotate or re-light the mark.

## Brand files in `logos/`

- `circe-mark.png`: the mark alone, 530px, its glow as transparent light. Only on `orb-void` or the rail; on light grounds the glow washes out.
- `circe-mark-on-void.png`: the mark on its own black square, for places that cannot composite transparency.
- `circe-app-icon.png`: the rounded Void tile with the mark. The mark to use on any light surface.
- `circe-lockup-on-void.png`: mark, wordmark and the tagline "One assistant. All your machines." Splash, about and marketing only.
- `circe-wordmark-light.png` / `circe-wordmark-dark.png`: the wordmark for dark and light grounds.
- `circe-avatar.png`: the circular avatar, for Circe as a participant (bot identities, notifications).
- `circe-favicon.png`: the small tile, drawn heavier, for 16 to 32px.
- `circe-mark-mono.png`: monochrome, for print, tray templates and watermarks.

Clear space is half the mark's width on every side. The smallest mark is 20px; below that use the favicon.

## Platform icons

`circe-master.png` (1254px) is the source for every packaged icon: the mark on a rounded Void tile, because the mark's glow disappears on a light dock or launcher. `pnpm circe:assets` renders the iOS, macOS, Linux, Windows and web icons from it and `pnpm circe:assets:check` reports stale ones. The master is built from the 530px mark, so a vector or higher-resolution mark should replace it before a store release. The mobile app icons come from their own Icon Composer sources in `apps/mobile/assets` and still carry the previous mark.

`circe-mark.svg` embeds the transparent mark and is the vector source the asset tests read.
