import { Pressable, ScrollView, Text as RNText, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { CirceWelcomeHero } from "../../components/circe-welcome-hero/CirceWelcomeHero";
import { CirceSignInError, CirceSignInPanel } from "./CirceSignInPanel";
import { LegalFooter } from "./LegalFooter";
import type { CirceGoogleSignIn } from "./useCirceGoogleSignIn";
import { COPPER_TEXT, DISPLAY_SERIF, INK, MUTED } from "./welcomeAuthTokens";
import { CirceMark } from "./welcomeMarks";

/**
 * The Circe sign-up surface. First-run onboarding and the settings account
 * route render this same page, so signing in looks identical wherever the user
 * enters it. A second, plainer composition is how the two surfaces drift.
 *
 * `onContinueAsGuest` is the onboarding-only escape hatch: it is absent when
 * the user is already a guest, because the account route is exactly where they
 * go to stop being one.
 *
 * The surface owns composition only. Google runs through Clerk's `useOAuth`
 * and everything else through Clerk's `AuthView`; the page never renders an
 * auth flow of its own.
 */
export function CirceSignInSurface(props: {
  readonly auth: CirceGoogleSignIn;
  readonly onOpenLegal: (url: string) => void;
  /** Hands email off to Clerk's AuthView; see the panel. */
  readonly onContinueWithEmail: () => void;
  readonly onContinueAsGuest?: () => void;
  /**
   * The onboarding route is the whole screen and owns the status bar inset.
   * The account route sits under a navigation header that already paid it.
   */
  readonly applyTopInset?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const topInset = props.applyTopInset === false ? 10 : insets.top + 10;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: 22,
        paddingTop: topInset,
        paddingBottom: Math.max(insets.bottom, 16),
      }}
    >
      <View
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9 }}
      >
        <CirceMark height={30} />
        <Text style={{ color: INK, fontSize: 16, letterSpacing: 6 }}>CIRCE</Text>
      </View>

      {/* Hero sits directly under the wordmark and above the headline. It is
          full-bleed, so it cancels the screen's horizontal padding rather than
          being inset like the text. */}
      <View style={{ marginHorizontal: -22, marginTop: 10 }}>
        <CirceWelcomeHero width={width} />
      </View>

      {/* The break is explicit, and the first line is short enough to hold at
          this size. Left to wrap, a longer first line spills onto a third line
          and the block loses the two-line balance. */}
      <RNText
        style={{
          fontFamily: DISPLAY_SERIF,
          color: INK,
          fontSize: 34,
          lineHeight: 40,
          textAlign: "center",
          marginTop: 12,
        }}
      >
        Direct work across{"\n"}
        <RNText style={{ fontFamily: DISPLAY_SERIF, color: COPPER_TEXT }}>every machine.</RNText>
      </RNText>

      <Text
        style={{ color: MUTED, fontSize: 15, lineHeight: 22, textAlign: "center", marginTop: 8 }}
      >
        Talk, plan and get things done across your projects and machines. Naturally.
      </Text>

      <View style={{ marginTop: 24 }}>
        <CirceSignInPanel auth={props.auth} onContinueWithEmail={props.onContinueWithEmail} />
      </View>

      <CirceSignInError message={props.auth.errorMessage} />

      {props.onContinueAsGuest ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue as guest"
          onPress={props.onContinueAsGuest}
          style={{ marginTop: 20, paddingVertical: 10 }}
        >
          <Text style={{ color: INK, fontSize: 15, fontWeight: "500", textAlign: "center" }}>
            Continue as guest
          </Text>
        </Pressable>
      ) : null}

      <LegalFooter onOpenDocument={props.onOpenLegal} spacer />
    </ScrollView>
  );
}
