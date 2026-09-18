import { AuthView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { StatusBar, View } from "react-native";

import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { CirceMark } from "./welcomeMarks";

/**
 * Clerk's native sign-in for the welcome flow.
 *
 * `AuthView` is Clerk's own native UI — SwiftUI on iOS, Compose on Android —
 * rendered inline in this hierarchy. Clerk owns the email code, the second
 * factor, resend, verification, and every strategy the deployment has enabled,
 * and it syncs the session back to the JS SDK itself. The Circe mark replaces
 * Clerk's dashboard logo so the step still belongs to the brand; a completed
 * sign-in activates the relay session and the signed-out gate moves the user
 * into the app plus mesh onboarding.
 */
export function WelcomeAuthRouteScreen() {
  const navigation = useNavigation();
  const handleHostBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.dispatch(StackActions.replace("Welcome"));
    }
  }, [navigation]);

  if (!hasCloudPublicConfig()) {
    return null;
  }

  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: "#FAF7F3" }}>
      <StatusBar barStyle="dark-content" />
      <AuthView
        isDismissible={false}
        onHostBack={handleHostBack}
        logo={<CirceMark height={40} />}
      />
    </View>
  );
}
