import * as Font from "expo-font";
import * as Linking from "expo-linking";

import { isNavigableDeepLink } from "./lib/deepLinkRouting";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation } from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { CirceMobileProvider } from "./features/circe/CirceMobileProvider";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { shouldHandleAppLink } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

// The Circe display serif is also registered natively in app.config.ts, which
// is what release builds use. Loading it here as well keeps the font available
// in a dev client that was built before the native registration existed, so the
// welcome hero can be judged without a full native rebuild. Loading an already
// registered family is a no-op.
void Font.loadAsync({
  "InstrumentSerif-Regular": require("@expo-google-fonts/instrument-serif/400Regular/InstrumentSerif_400Regular.ttf"),
}).catch(() => {
  // Falls back to the stack in --font-circe-serif.
});

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

const appLinking = {
  // Legacy `t3code*` schemes stay registered as aliases: links already shared
  // in QR codes, widgets, and push payloads must keep resolving after the
  // rename to Circe. New links use the Circe scheme.
  prefixes: [
    Linking.createURL("/"),
    "circe://",
    "circe-dev://",
    "circe-preview://",
    "t3code://",
    "t3code-dev://",
    "t3code-preview://",
  ],
  // Keep the compact thread list available beneath a directly opened thread.
  config: { initialRouteName: "Home" },
  // Launcher URLs, share wake-ups, auth callbacks, and scheme-only wake-ups all
  // arrive looking like links but belong to other machinery, and any of them
  // that reaches the router lands on the NotFound route.
  filter: (url: string) => isNavigableDeepLink(url) && shouldHandleAppLink(url),
};

const Navigation = createStaticNavigation(RootStack);

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

  return null;
}

export default function App() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <AppContent />
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();

  return (
    <>
      <SplashScreenCoordinator />
      <SubscriptionUsageCoordinator />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <StatusBar
              barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"}
              translucent
            />
            {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
            <View style={{ flex: 1 }}>
              <IncomingShareProvider>
                <CirceMobileProvider>
                  <Navigation linking={appLinking} theme={navigationTheme} />
                </CirceMobileProvider>
              </IncomingShareProvider>
              <ConfirmDialogHost />
              <ThreadArrangementHost />
            </View>
            {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
            <OverlayPortalHost />
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
