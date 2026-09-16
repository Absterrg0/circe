import { describe, expect, it } from "vite-plus/test";

import { isAuthCallbackUrl, isNavigableDeepLink } from "./deepLinkRouting";

/**
 * A Google sign-in came back to `<scheme>://oauth-native-callback`, the router
 * matched it against the app's own scheme, found no route, and replaced the
 * sign-in screen with the NotFound screen. The user was left signed out with
 * only a "Return home" button, and nothing in the code looked wrong.
 */
describe("deep link routing", () => {
  it("keeps Clerk's auth callbacks away from the router", () => {
    expect(isAuthCallbackUrl("circe-dev://oauth-native-callback")).toBe(true);
    expect(isAuthCallbackUrl("circe-dev://oauth-native-callback?rotating_token_nonce=abc")).toBe(
      true,
    );
    expect(isAuthCallbackUrl("circe://oauth-native-callback")).toBe(true);
    expect(isAuthCallbackUrl("circe-dev://sso-callback")).toBe(true);
    expect(isAuthCallbackUrl("circe-dev://hosted-auth-callback")).toBe(true);
    expect(isAuthCallbackUrl("clerk://com.abstergo.circe.dev.hosted-callback")).toBe(true);

    expect(isNavigableDeepLink("circe-dev://oauth-native-callback")).toBe(false);
    expect(isNavigableDeepLink("circe-dev://sso-callback?rotating_token_nonce=abc")).toBe(false);
  });

  it("still routes the links the app owns", () => {
    expect(isNavigableDeepLink("circe-dev://welcome")).toBe(true);
    expect(isNavigableDeepLink("circe-dev://welcome/verify?email=a%40b.com")).toBe(true);
    expect(isNavigableDeepLink("circe-dev://connections/new?pairingUrl=x&autoConnect=1")).toBe(
      true,
    );
    expect(isNavigableDeepLink("circe-dev://thread/abc/terminal")).toBe(true);
  });

  it("still ignores the launcher and share wake-ups", () => {
    expect(isNavigableDeepLink("circe-dev://expo-development-client/?url=http%3A%2F%2Fx")).toBe(
      false,
    );
    expect(isNavigableDeepLink("circe-dev://expo-sharing")).toBe(false);
  });
});
