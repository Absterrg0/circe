import type { CirceTaskDeskView, ThreadId } from "@circe/contracts";
import { Pressable, View } from "react-native";

import {
  buildCirceNeedsAttention,
  circeNeedsAttentionIsEmpty,
  type CirceAttentionReason,
} from "@circe/client-runtime/circe/overview";
import { AppText as Text } from "../../components/AppText";

const reasonLabel = (reason: CirceAttentionReason): string => {
  switch (reason) {
    case "approval":
      return "Approval";
    case "input":
      return "Input";
    case "failed":
      return "Failed";
  }
};

/**
 * The desk as a short "needs attention" card: the session's blocking question
 * and every task waiting on a person. Tapping a task focuses it so the next
 * answer lands on the right thread.
 */
export function CirceNeedsAttention({
  desk,
  onFocusTask,
}: {
  readonly desk: CirceTaskDeskView | null;
  readonly onFocusTask: (threadId: ThreadId) => void;
}) {
  if (desk === null) return null;
  const attention = buildCirceNeedsAttention(desk);
  if (circeNeedsAttentionIsEmpty(attention)) return null;
  return (
    <View className="gap-2 rounded-2xl border border-border-subtle bg-card px-4 py-3">
      <Text className="text-sm font-t3-bold text-foreground">Needs attention</Text>
      {attention.frame !== null ? (
        <Text className="text-sm text-foreground-muted">{attention.frame.prompt}</Text>
      ) : null}
      {attention.tasks.map((entry) => (
        <Pressable
          key={entry.threadId}
          accessibilityRole="button"
          onPress={() => onFocusTask(entry.threadId)}
          className="flex-row items-center justify-between gap-2 rounded-xl bg-subtle px-3 py-2 active:opacity-70"
        >
          <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
            {entry.title}
          </Text>
          <Text className="text-xs text-foreground-muted">{reasonLabel(entry.reason)}</Text>
        </Pressable>
      ))}
    </View>
  );
}
