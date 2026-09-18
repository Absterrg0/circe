import { ProjectId, type CirceMemoryIndex } from "@circe/contracts";
import { type CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { circeEnvironment } from "../../state/circe";
import { useAtomCommand } from "../../state/use-atom-command";

type Project = CirceMeshCatalog["projects"][number];

/**
 * Memory escape hatch for one project: what Circe remembers, with provenance
 * and a way to forget an entry (retired, not destroyed). Memory is node-local,
 * and Circe maintains it on its own, so this stays a small read/forget list.
 */
export function CirceMemories({ project }: { readonly project: Project | undefined }) {
  const memoryIndex = useAtomCommand(circeEnvironment.memoryIndex, {
    reportFailure: false,
    reportDefect: false,
  });
  const forgetMemory = useAtomCommand(circeEnvironment.forgetMemory, {
    reportFailure: false,
    reportDefect: false,
  });
  const [index, setIndex] = useState<CirceMemoryIndex | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const environmentId = project?.ref.nodeId;
  const projectId = project?.ref.projectId;

  const load = useCallback(async () => {
    if (environmentId === undefined || projectId === undefined) return;
    const result = await memoryIndex({
      environmentId,
      input: { projectId: ProjectId.make(projectId) },
    });
    if (result._tag === "Failure") {
      setMessage("Could not read this project's memory.");
      setIndex(null);
      return;
    }
    setMessage(null);
    setIndex(result.value);
  }, [environmentId, memoryIndex, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (project === undefined || environmentId === undefined) return null;

  const forget = async (entryId: string) => {
    if (projectId === undefined) return;
    const result = await forgetMemory({
      environmentId,
      input: { projectId: ProjectId.make(projectId), entryId },
    });
    if (result._tag === "Failure") {
      setMessage("Could not forget that memory.");
      return;
    }
    await load();
  };

  const entries = index?.entries ?? [];
  return (
    <View className="gap-2 rounded-2xl border border-border-subtle bg-card px-4 py-3">
      <Text className="text-sm font-t3-bold text-foreground">
        Memories{entries.length > 0 ? ` (${entries.length})` : ""}
      </Text>
      {message !== null ? (
        <Text className="text-xs text-foreground-muted">{message}</Text>
      ) : entries.length === 0 ? (
        <Text className="text-xs text-foreground-muted">Nothing remembered yet.</Text>
      ) : (
        entries.map((entry) => (
          <View
            key={entry.id}
            className="flex-row items-center justify-between gap-2 rounded-xl bg-subtle px-3 py-2"
          >
            <View className="min-w-0 flex-1">
              <Text className="text-sm text-foreground" numberOfLines={1}>
                {entry.title}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {entry.kind} · from {entry.source}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Forget memory ${entry.title}`}
              onPress={() => void forget(entry.id)}
              className="rounded-lg px-2 py-1 active:opacity-70"
            >
              <Text className="text-xs text-destructive">Forget</Text>
            </Pressable>
          </View>
        ))
      )}
    </View>
  );
}
