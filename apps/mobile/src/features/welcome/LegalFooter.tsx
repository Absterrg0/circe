import { type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from "../settings/lib/legal-document-url";
import { FAINT, MUTED } from "./welcomeAuthTokens";

/**
 * The legal line shared by every Circe sign-in surface. `spacer` pushes it to
 * the bottom of a full-page layout; the settings sheet leaves it out and keeps
 * it under the controls.
 */
export function LegalFooter({
  onOpenDocument,
  spacer = false,
}: {
  readonly onOpenDocument: (url: string) => void;
  readonly spacer?: boolean;
}): ReactNode {
  return (
    <>
      {spacer ? <View style={{ flex: 1, minHeight: 20 }} /> : null}
      <Text style={{ color: FAINT, fontSize: 10.5, lineHeight: 16, textAlign: "center" }}>
        By continuing, you agree to our{" "}
        <Text
          accessibilityRole="link"
          style={{ color: MUTED, textDecorationLine: "underline" }}
          onPress={() => onOpenDocument(TERMS_OF_SERVICE_URL)}
        >
          Terms of Service
        </Text>{" "}
        and{" "}
        <Text
          accessibilityRole="link"
          style={{ color: MUTED, textDecorationLine: "underline" }}
          onPress={() => onOpenDocument(PRIVACY_POLICY_URL)}
        >
          Privacy Policy
        </Text>
        .
      </Text>
    </>
  );
}
