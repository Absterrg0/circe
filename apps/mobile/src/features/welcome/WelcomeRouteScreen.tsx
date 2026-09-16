import { StackActions, useNavigation } from "@react-navigation/native";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect } from "react";
import { ScrollView, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { setGuestMode } from "../cloud/guestMode";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { CirceSignInSurface } from "./CirceSignInSurface";
import { useCirceGoogleSignIn } from "./useCirceGoogleSignIn";
import { INK, IVORY, MUTED } from "./welcomeAuthTokens";
import { CirceMark } from "./welcomeMarks";

void WebBrowser.maybeCompleteAuthSession();

function useWarmUpBrowser(): void {
  useEffect(() => {
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

/**
 * Branded sign-in entry for Circe Mesh. Signed-out users land here so the
 * first thing they do is connect an account; sign-in activates the relay
 * session and the mesh onboarding sheet takes it from there. Guests can skip
 * the account entirely, which the signed-out gate then respects. The surface is
 * fixed ivory per the brand reference, independent of system theme.
 */
export function WelcomeRouteScreen() {
  return (
    <>
      <StatusBar barStyle="dark-content" />
      <View style={{ flex: 1, backgroundColor: IVORY }}>
        {hasCloudPublicConfig() ? <ConfiguredWelcome /> : <UnconfiguredWelcome />}
      </View>
    </>
  );
}

function UnconfiguredWelcome() {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        paddingTop: insets.top + 24,
        paddingBottom: Math.max(insets.bottom, 24),
      }}
    >
      <CirceMark />
      <Text style={{ color: INK, fontSize: 22, fontWeight: "700" }}>Circe Mesh unavailable</Text>
      <Text style={{ color: MUTED, fontSize: 15, textAlign: "center", lineHeight: 22 }}>
        This build has no account service configured, so sign-in is turned off.
      </Text>
    </ScrollView>
  );
}

function ConfiguredWelcome() {
  const navigation = useNavigation();
  useWarmUpBrowser();
  const auth = useCirceGoogleSignIn();

  // Email leaves this surface for Clerk's AuthView, which owns the code,
  // second-factor, resend, and verification steps rather than this app
  // re-implementing them.
  const continueWithEmail = useCallback(() => {
    navigation.navigate("WelcomeAuth" as never);
  }, [navigation]);

  const openLegalDocument = useCallback((url: string) => {
    void WebBrowser.openBrowserAsync(url);
  }, []);

  const continueAsGuest = useCallback(() => {
    // The in-memory flag flips before the write resolves, so the gate already
    // agrees by the time the route changes. A failed write only costs the user
    // a second tap on the next launch.
    void setGuestMode(true).catch(() => undefined);
    navigation.dispatch(StackActions.replace("Circe"));
  }, [navigation]);

  return (
    <CirceSignInSurface
      auth={auth}
      onOpenLegal={openLegalDocument}
      onContinueWithEmail={continueWithEmail}
      onContinueAsGuest={continueAsGuest}
    />
  );
}
