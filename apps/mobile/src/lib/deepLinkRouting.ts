/**
 * Which incoming URLs belong to navigation, and which belong to something else.
 *
 * React Navigation matches any URL under a registered scheme against the route
 * tree and falls through to the NotFound route when nothing matches. Two kinds
 * of URL arrive during normal use that are not navigation at all, and both are
 * silent when they go wrong: the app simply ends up on the wrong screen.
 */

/**
 * Clerk's native auth callbacks, as paths under the app's own scheme.
 *
 * These are redirects the web auth session returns to the app, and
 * `startOAuthFlow` reads its result out of the URL itself. They are results,
 * not navigation links. Leaving them to navigation lands the return from Google
 * on the NotFound screen, which unmounts the screen that started the flow and
 * leaves the user signed out with only a "Return home" button.
 *
 * `useOAuth` uses the first path, `useSSO` the second, and `useHostedAuth` the
 * third (or a `clerk://` URL on Android). All of them are excluded rather than
 * only the one currently wired, so adding a strategy later cannot reintroduce
 * this.
 */
export const AUTH_CALLBACK_MARKERS = [
  "oauth-native-callback",
  "sso-callback",
  "hosted-auth-callback",
] as const;

export function isAuthCallbackUrl(url: string): boolean {
  return url.startsWith("clerk://") || AUTH_CALLBACK_MARKERS.some((path) => url.includes(path));
}

/**
 * The Expo dev client launches the app through the launcher, not the router:
 * `<scheme>://expo-development-client/?url=<packager>`. expo-sharing wakes the
 * app with a private lifecycle URL and lets the persisted share inbox own
 * navigation once the payload is durable.
 */
const NON_NAVIGATION_MARKERS = ["expo-development-client", "://expo-sharing"] as const;

/** True when a received URL should be handled by the router. */
export function isNavigableDeepLink(url: string): boolean {
  if (isAuthCallbackUrl(url)) return false;
  return !NON_NAVIGATION_MARKERS.some((marker) => url.includes(marker));
}
