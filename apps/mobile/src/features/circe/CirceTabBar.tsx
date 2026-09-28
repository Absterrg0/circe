import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useMemo } from "react";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThreadShells } from "../../state/entities";

export type CirceTabId = "home" | "tasks" | "library";

const TABS: ReadonlyArray<{
  id: CirceTabId;
  label: string;
  icon: "house" | "list.bullet" | "book.closed";
}> = [
  { id: "home", label: "Home", icon: "house" },
  { id: "tasks", label: "Tasks", icon: "list.bullet" },
  { id: "library", label: "Library", icon: "book.closed" },
];

/**
 * Bottom tab bar from the Circe design: chrome bar with a hairline top rule,
 * an ember icon and ink label for the active tab. Tasks carries the gold
 * count of tasks that need you. Library opens the archived-threads sheet; it
 * never owns a stack route so it never stays selected after the sheet
 * dismisses.
 */
export function CirceTabBar({ selected }: { readonly selected: CirceTabId }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const threads = useThreadShells();
  const needs = useMemo(
    () =>
      threads.filter(
        (thread) =>
          thread.archivedAt === null && (thread.hasPendingApprovals || thread.hasPendingUserInput),
      ).length,
    [threads],
  );

  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-circe-tabbar-border bg-circe-tabbar"
      style={{ paddingBottom: Math.max(insets.bottom, 12), paddingTop: 8 }}
    >
      {TABS.map((tab) => {
        const active = selected === tab.id;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={
              tab.id === "tasks" && needs > 0 ? `Tasks, ${needs} need you` : tab.label
            }
            onPress={() => {
              if (tab.id === "home") navigation.navigate("Circe");
              else if (tab.id === "tasks") navigation.navigate("Home");
              else
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsArchive" },
                });
            }}
            className="flex-1 items-center justify-center gap-1 py-1 active:opacity-70"
          >
            <View>
              <SymbolView
                name={tab.icon}
                size={22}
                tintColorClassName={active ? "accent-circe-copper" : "accent-icon-muted"}
              />
              {tab.id === "tasks" && needs > 0 ? (
                <View className="absolute -right-2.5 -top-1.5 h-4 min-w-4 items-center justify-center rounded-full bg-circe-attention px-1">
                  <Text className="text-3xs font-t3-bold text-circe-on-attention">
                    {needs > 99 ? "99+" : needs}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              className={`text-2xs font-t3-medium ${active ? "text-foreground" : "text-circe-ink-faint"}`}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
