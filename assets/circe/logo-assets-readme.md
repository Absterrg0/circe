# Circe logo assets

The mark is Prism Orbit: translucent orange, rose, and violet ribbons orbiting a dark center. It is
emissive artwork, so it is made to sit on dark surfaces.

## Sources

- `circe-master.png` is the transparent mark (1254 px). In-app surfaces use it through
  `apps/web/public/circe-mark.png`; on light surfaces the app sets it on a small charcoal tile.
- `circe-app-icon-master.png` is the mark on its charcoal rounded tile with a faint orange rim
  (1254 px). App icons, favicons, and the splash use it.
- `circe-mark.svg` embeds the transparent mark so the gradients match the artwork exactly instead of
  approximating them with an auto-trace.

Run `pnpm circe:assets` to render every icon, favicon, and in-app mark from the two masters, and
`pnpm circe:assets:check` to confirm the checked-in renditions are current. Both need ImageMagick 7.

`logo-horizontal-on-light.svg` and `logo-horizontal-on-dark.svg` still carry the retired mark and are
not used by the app.
