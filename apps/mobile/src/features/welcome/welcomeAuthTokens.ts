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
export const FAINT = "#6C655C";
export const COPPER_TEXT = "#A04A27";
export const COPPER = "#E18A62";
export const PANEL = "rgba(255, 253, 250, 0.72)";
export const PANEL_BORDER = "#E3DDD4";
export const FIELD = "#FFFFFF";
export const FIELD_BORDER = "#D6CFC5";
export const PLACEHOLDER = "#6C655C";
export const RULE = "#E3DDD4";
/** Copper submit disc: the Daylight ember, so the white arrow reads at 4.5:1. */
export const COPPER_DISC = "#A04A27";
export const ERROR_TEXT = "#B23A2E";

/**
 * Applied explicitly to headline text rather than through a class.
 * `AppText` sets font-sans, and layering a display class on top of it left the
 * pair fighting, with whichever won depending on render order.
 */
export const DISPLAY_FACE = "Sora-SemiBold";
