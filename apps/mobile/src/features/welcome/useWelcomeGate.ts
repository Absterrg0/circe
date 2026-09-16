import { useAuth } from "@clerk/expo";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type NavigationState,
} from "@react-navigation/native";
import { useEffect, useState } from "react";

import { ensureGuestModeLoaded, setGuestMode, useGuestMode } from "../cloud/guestMode";

/** Routes the gate leaves alone, so onboarding and dev tooling stay reachable. */
const GATE_EXEMPT_ROUTES: ReadonlySet<string> = new Set(["Welcome", "WelcomeAuth", "OrbGallery"]);

/**
 * How long to wait for Clerk before assuming there is no session.
 *
 * Without this, a device that cannot reach Clerk's servers never reports
 * `isLoaded`, the gate returns early forever, and a signed-out user is dropped
 * straight into the app with no way to connect through Circe Mesh. Treating a
 * stalled load as signed out is the safer failure: Welcome can always sign the
 * user back in, and a genuinely stored session resolves from the token cache
 * without the network.
 */
const CLERK_LOAD_TIMEOUT_MS = 3000;

/**
 * Signed-out gate for Circe Mesh onboarding.
 *
 * When the account service is configured and there is no usable session, any
 * route outside the welcome flow is replaced with Welcome, so connecting
 * through the mesh is the front door rather than an option buried in settings.
 * Signed-in users who land on Welcome are sent into the app. Without cloud
 * config the gate is never mounted and navigation behaves exactly as before.
 *
 * Guest mode is the deliberate exception: a user who chose "Continue as guest"
 * keeps the app without an account, so the gate lets the app stand. Activating
 * a session always clears the flag, so a later sign-in takes over cleanly.
 */
export function WelcomeGate({ state }: { readonly state: NavigationState }) {
  const navigation = useNavigation();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const [timedOut, setTimedOut] = useState(false);
  const guestMode = useGuestMode();

  useEffect(() => {
    if (isLoaded) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setTimedOut(true), CLERK_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isLoaded]);

  // The flag is durable state, not session state, so the gate waits for it
  // rather than letting a guest bounce through Welcome on every cold start.
  useEffect(() => {
    void ensureGuestModeLoaded();
  }, []);

  const resolved = (isLoaded || timedOut) && guestMode !== null;
  const signedIn = isLoaded && isSignedIn === true;
  const guest = guestMode === true;
  const exempt = GATE_EXEMPT_ROUTES.has(state.routes[state.index]?.name ?? "");

  useEffect(() => {
    if (signedIn && guest) {
      // Signing in supersedes the guest decision. A failed write leaves the
      // flag set, so the next launch asks once more rather than hiding it.
      void setGuestMode(false).catch(() => undefined);
    }
  }, [guest, signedIn]);

  useEffect(() => {
    if (!resolved) return;
    if (signedIn) {
      // Reset rather than replace: the user may have pushed the verification
      // step on top of Welcome, and neither belongs under a back gesture once
      // the session is active.
      if (exempt) {
        navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: "Circe" }] }));
      }
      return;
    }
    if (!exempt && !guest) {
      navigation.dispatch(StackActions.replace("Welcome"));
    }
  }, [exempt, guest, navigation, resolved, signedIn]);

  return null;
}
