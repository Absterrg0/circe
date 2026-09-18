import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { ActivityIndicator, StatusBar, View } from "react-native";

import { CIRCE_IVORY } from "../../lib/circeBrandColors";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { CirceMark } from "../welcome/welcomeMarks";

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useLayoutEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("SettingsContent"));
    }
  }, [navigation]);

  return hasCloudPublicConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const handleHostBack = useCallback(
    () => navigation.dispatch(StackActions.popTo("SettingsContent")),
    [navigation],
  );
  const hasBeenSignedIn = useRef(isSignedIn);
  if (isSignedIn) {
    hasBeenSignedIn.current = true;
  }

  useEffect(() => {
    if (hasBeenSignedIn.current && isLoaded && isSignedIn === false) {
      navigation.dispatch(StackActions.popTo("SettingsContent"));
    }
  }, [isLoaded, isSignedIn, navigation]);

  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: CIRCE_IVORY }}>
      <StatusBar barStyle="dark-content" />
      {isLoaded ? (
        hasBeenSignedIn.current ? (
          <UserProfileView isDismissible={false} onHostBack={handleHostBack} />
        ) : (
          <AuthView
            isDismissible={false}
            onHostBack={handleHostBack}
            logo={<CirceMark height={40} />}
          />
        )
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator size="large" />
        </View>
      )}
    </View>
  );
}
