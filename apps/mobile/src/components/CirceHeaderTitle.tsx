import { Image, View } from "react-native";

import { AppText as Text } from "./AppText";

/**
 * The Circe brand lockup for native navigation bars: the approved brand mark
 * followed by the wordmark.
 *
 * Rendered from the brand asset rather than an icon font, so the mark matches
 * the welcome screen and every other Circe surface. The source is 220x250, so
 * height drives the size and width follows the asset's own ratio.
 */
export function CirceHeaderTitle() {
  return (
    <View
      aria-level={1}
      accessibilityLabel="Circe"
      accessible
      role="heading"
      className="flex-row items-center gap-2"
    >
      <Image
        source={require("../../assets/circe/circe-mark.png")}
        style={{ height: 22, width: (22 * 220) / 250 }}
        resizeMode="contain"
      />
      <Text className="font-t3-bold text-[19px] tracking-[-0.3px] text-foreground">Circe</Text>
    </View>
  );
}

export function renderCirceHeaderTitle() {
  return <CirceHeaderTitle />;
}
