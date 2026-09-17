/**
 * The fixed-light Circe brand surface.
 *
 * Brand pages — the welcome and sign-in surface, the verification step, and the
 * account route in settings — are ivory regardless of the system theme. These
 * three values are the whole palette those pages need, and they live here rather
 * than beside the sign-in components because the screen header renders one of
 * them too, and a shared UI component importing from a feature folder inverts
 * the layering the app is built on.
 */
export const CIRCE_IVORY = "#FCF9F4";
export const CIRCE_INK = "#151311";
export const CIRCE_MUTED = "#707177";
