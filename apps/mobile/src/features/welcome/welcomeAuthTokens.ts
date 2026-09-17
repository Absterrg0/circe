/**
 * Shared palette for the Circe sign-in surfaces.
 *
 * The welcome route and the settings account route both render the same brand
 * controls, so the values live here rather than being copied between screens.
 * Warm ivory paper, near-black editorial ink, one burnt-copper phrase, and a
 * lighter auth panel with a hairline border instead of a shadow.
 *
 * The three fixed-light surface colours are re-exported from the shared brand
 * palette so the screen header and these pages cannot drift apart.
 */
export {
  CIRCE_INK as INK,
  CIRCE_IVORY as IVORY,
  CIRCE_MUTED as MUTED,
} from "../../lib/circeBrandColors";
export const FAINT = "#918A84";
export const COPPER_TEXT = "#A5482C";
export const COPPER = "#E08A63";
export const PANEL = "rgba(255, 253, 250, 0.72)";
export const PANEL_BORDER = "rgba(56, 43, 35, 0.07)";
export const FIELD = "#FFFFFF";
export const FIELD_BORDER = "rgba(56, 43, 35, 0.09)";
export const PLACEHOLDER = "#AAA39C";
export const RULE = "rgba(56, 43, 35, 0.12)";
/** Copper submit disc. Deeper than the accent so the white arrow stays legible. */
export const COPPER_DISC = "#AE6E4C";
export const ERROR_TEXT = "#B3402E";

/**
 * Applied explicitly to headline text rather than through a class.
 * `AppText` sets font-sans, and layering a serif class on top of it left the
 * pair fighting, with whichever won depending on render order.
 */
export const DISPLAY_SERIF = "InstrumentSerif-Regular";
