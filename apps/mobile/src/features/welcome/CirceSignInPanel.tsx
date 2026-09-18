import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { CirceGoogleSignIn } from "./useCirceGoogleSignIn";
import { ArrowMark, EnvelopeMark, GoogleMark } from "./welcomeMarks";
import {
  ERROR_TEXT,
  FAINT,
  FIELD,
  FIELD_BORDER,
  INK,
  PANEL,
  PANEL_BORDER,
  RULE,
} from "./welcomeAuthTokens";

/**
 * The Circe sign-in entry controls.
 *
 * Google runs here because Clerk's `useOAuth` is the entire flow. Email does
 * not: the panel hands off to Clerk's `AuthView`, which owns the code entry,
 * the second factor, resend, verification, and every other enabled strategy.
 * That hand-off is the point — the branded surface chooses how signing in
 * starts, not how it works.
 *
 * The panel is a lighter surface than the page with a hairline border rather
 * than a shadow, so a hero beside it keeps the only strong contrast.
 */
export function CirceSignInPanel({
  auth,
  onContinueWithEmail,
}: {
  readonly auth: CirceGoogleSignIn;
  readonly onContinueWithEmail: () => void;
}) {
  return (
    <View
      style={{
        padding: 12,
        borderRadius: 26,
        backgroundColor: PANEL,
        borderWidth: 1,
        borderColor: PANEL_BORDER,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
        onPress={auth.continueWithGoogle}
        disabled={auth.googleBusy}
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: FIELD,
          borderColor: FIELD_BORDER,
          borderWidth: 1,
          borderRadius: 999,
          paddingVertical: 15,
          paddingHorizontal: 18,
          opacity: auth.googleBusy ? 0.7 : 1,
        }}
      >
        <GoogleMark size={21} />
        <Text
          style={{
            flex: 1,
            color: INK,
            fontSize: 16,
            fontWeight: "500",
            textAlign: "center",
          }}
        >
          {auth.googleBusy ? "Connecting…" : "Continue with Google"}
        </Text>
        <ArrowMark size={18} />
      </Pressable>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 13 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: RULE }} />
        <Text style={{ color: FAINT, fontSize: 11, letterSpacing: 2 }}>OR</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: RULE }} />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Continue with email"
        onPress={onContinueWithEmail}
        style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: FIELD,
          borderColor: FIELD_BORDER,
          borderWidth: 1,
          borderRadius: 999,
          paddingVertical: 15,
          paddingHorizontal: 18,
        }}
      >
        <EnvelopeMark size={20} />
        <Text
          style={{
            flex: 1,
            color: INK,
            fontSize: 16,
            fontWeight: "500",
            textAlign: "center",
          }}
        >
          Continue with email
        </Text>
        <ArrowMark size={18} />
      </Pressable>
    </View>
  );
}

/** Error text placed under the panel, matching the panel's width on both screens. */
export function CirceSignInError({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <Text
      style={{
        color: ERROR_TEXT,
        fontSize: 13,
        lineHeight: 19,
        textAlign: "center",
        marginTop: 12,
      }}
    >
      {message}
    </Text>
  );
}
