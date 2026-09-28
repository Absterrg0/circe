import { useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@circe/client/state/shell";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { MOBILE_SECTION_LABEL } from "../../lib/typography";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import type { CirceHomeSummary } from "./circeHomeSummary";

type Summary = CirceHomeSummary<EnvironmentThreadShell>;

function relativeAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return "";
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function SectionLabel({
  label,
  count,
  attention = false,
}: {
  readonly label: string;
  readonly count: number;
  readonly attention?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-2 px-1 pb-2 pt-5">
      <Text
        className={`font-circe-display ${attention ? "text-circe-attention" : "text-circe-ink-faint"}`}
        style={MOBILE_SECTION_LABEL}
      >
        {label}
      </Text>
      <Text
        className={`font-mono text-3xs ${attention ? "text-circe-attention" : "text-circe-ink-faint"}`}
      >
        {count}
      </Text>
    </View>
  );
}

/** The haloed gold dot for work that needs you, or the ember dot for work that runs. */
function StateDot({ state }: { readonly state: "needs" | "running" }) {
  return state === "needs" ? (
    <View className="h-3.5 w-3.5 items-center justify-center rounded-full bg-circe-attention-soft">
      <View className="h-2 w-2 rounded-full bg-circe-attention" />
    </View>
  ) : (
    <View className="h-3.5 w-3.5 items-center justify-center rounded-full border border-circe-copper/40">
      <View className="h-1.5 w-1.5 rounded-full bg-circe-copper" />
    </View>
  );
}

/**
 * The home screen's work: tasks that need you as cards you can act on, then
 * running tasks as rows. Every task names its project and machine. Approvals
 * and answers open the task, where the full request is readable.
 */
export function CirceHomeWork({ summary }: { readonly summary: Summary }) {
  const navigation = useNavigation();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const now = summary.at;
  const projectTitle = useMemo(() => {
    const titles = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title] as const),
    );
    return (thread: EnvironmentThreadShell) =>
      titles.get(`${thread.environmentId}:${thread.projectId}`) ?? null;
  }, [projects]);
  const machine = useMemo(() => {
    const labels = new Map(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    );
    return (thread: EnvironmentThreadShell) =>
      labels.get(thread.environmentId)?.toLowerCase() ?? null;
  }, [environments]);
  const open = (thread: EnvironmentThreadShell) =>
    navigation.navigate("Thread", { environmentId: thread.environmentId, threadId: thread.id });

  const where = (thread: EnvironmentThreadShell) =>
    [projectTitle(thread), machine(thread) ? `@${machine(thread)}` : null]
      .filter(Boolean)
      .join("  ");

  if (summary.needs.length === 0 && summary.running.length === 0) return null;

  return (
    <View>
      {summary.needs.length > 0 ? (
        <>
          <SectionLabel label="Needs you" count={summary.needs.length} attention />
          <View className="gap-2">
            {summary.needs.map((thread) => (
              <View
                key={`${thread.environmentId}:${thread.id}`}
                className="gap-2 rounded-xl border border-circe-attention/30 bg-circe-attention-soft px-4 py-3.5"
              >
                <View className="flex-row items-center gap-2.5">
                  <StateDot state="needs" />
                  <Text
                    className="min-w-0 flex-1 text-base font-t3-bold text-circe-ink"
                    numberOfLines={1}
                  >
                    {thread.title}
                  </Text>
                  <Text className="text-2xs text-circe-ink-faint">
                    {relativeAge(thread.updatedAt, now)}
                  </Text>
                </View>
                <Text className="pl-6 text-xs text-circe-ink-faint" numberOfLines={1}>
                  {where(thread)}
                </Text>
                <Text className="pl-6 text-sm text-circe-copy">
                  {thread.hasPendingApprovals
                    ? "Wants your approval to continue"
                    : "Asked you a question"}
                </Text>
                <View className="flex-row gap-2 pl-6 pt-1">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${thread.hasPendingApprovals ? "Review" : "Answer"} ${thread.title}`}
                    onPress={() => open(thread)}
                    className="min-h-11 justify-center rounded-lg bg-primary px-4 active:opacity-70"
                  >
                    <Text className="text-sm font-t3-medium text-primary-foreground">
                      {thread.hasPendingApprovals ? "Review" : "Answer…"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        </>
      ) : null}
      {summary.running.length > 0 ? (
        <>
          <SectionLabel label="Running" count={summary.running.length} />
          <View>
            {summary.running.map((thread) => (
              <Pressable
                key={`${thread.environmentId}:${thread.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${thread.title}, running`}
                onPress={() => open(thread)}
                className="min-h-11 flex-row items-center gap-2.5 rounded-lg px-1 py-2 active:bg-subtle"
              >
                <StateDot state="running" />
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-sm font-t3-medium text-circe-ink" numberOfLines={1}>
                    {thread.title}
                  </Text>
                  <Text className="text-xs text-circe-ink-faint" numberOfLines={1}>
                    {where(thread)}
                  </Text>
                </View>
                <Text className="text-2xs text-circe-ink-faint">
                  {relativeAge(thread.updatedAt, now)}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}
