import { useClerk, useOAuth } from "@clerk/expo";
import { useCallback, useState } from "react";

/**
 * The one strategy the welcome surface runs itself.
 *
 * Google is on the branded page because it is the first thing most people
 * reach for, and Clerk's `useOAuth` is the whole flow: it opens the provider's
 * consent screen and hands back a session. Everything else — email codes,
 * second factors, resend, verification, and every other strategy the
 * deployment has enabled — belongs to Clerk's `AuthView`, which owns that UI
 * and keeps it correct. Re-implementing those flows here is what produced a
 * verify screen that crashed on a deep link, a resend that could wedge the
 * screen busy, and a silent no-op when the provider returned without a session.
 */
export interface CirceGoogleSignIn {
  readonly googleBusy: boolean;
  readonly errorMessage: string | null;
  continueWithGoogle(): void;
}

const NOT_READY = "Sign-in is still starting up. Try again in a moment.";
const GOOGLE_FAILED = "Google sign-in didn't finish. Try again or use email.";

export function useCirceGoogleSignIn(): CirceGoogleSignIn {
  const { setActive } = useClerk();
  const { startOAuthFlow } = useOAuth({ strategy: "oauth_google" });
  const [googleBusy, setGoogleBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const continueWithGoogle = useCallback(() => {
    void (async () => {
      setGoogleBusy(true);
      setErrorMessage(null);
      try {
        const result = await startOAuthFlow();
        if (result.createdSessionId && setActive) {
          await setActive({ session: result.createdSessionId });
          return;
        }

        // No session and no throw used to mean nothing happened at all: the
        // sheet closed and the user was left on the signed-out screen with no
        // explanation. Closing the sheet yourself is not a failure, but a
        // completed redirect that produced no session is, and it has to say so.
        const outcome = result.authSessionResult?.type;
        if (outcome === "cancel" || outcome === "dismiss") return;
        setErrorMessage(outcome === undefined ? NOT_READY : GOOGLE_FAILED);
      } catch {
        setErrorMessage(GOOGLE_FAILED);
      } finally {
        setGoogleBusy(false);
      }
    })();
  }, [setActive, startOAuthFlow]);

  return { googleBusy, errorMessage, continueWithGoogle };
}
