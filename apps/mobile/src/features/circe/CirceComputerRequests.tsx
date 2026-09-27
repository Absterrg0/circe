import type { CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";
import type { CirceComputerAccessView, EnvironmentId } from "@circe/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { circeEnvironment, setPresentedComputerRequest } from "../../state/circe";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Requests to use a paired node's computer, answered from this phone. The
 * node owns who uses its computer; each card renders that node's state as
 * it reports it, so a question Circe or a coding agent asked on any device
 * can be approved, denied, or stopped here, and it survives a reconnect.
 */
export function CirceComputerRequests(props: { readonly catalog: CirceMeshCatalog | null }) {
  const nodes = (props.catalog?.nodes ?? []).filter((node) => node.reachability === "online");
  return (
    <>
      {nodes.map((node) => (
        <NodeComputerRequest key={node.nodeId} nodeId={node.nodeId} nodeLabel={node.label} />
      ))}
    </>
  );
}

function NodeComputerRequest(props: {
  readonly nodeId: EnvironmentId;
  readonly nodeLabel: string;
}) {
  const result = useAtomValue(
    circeEnvironment.computerAccess({ environmentId: props.nodeId, input: {} }),
  );
  const decide = useAtomCommand(circeEnvironment.decideComputerAccess, {
    reportFailure: false,
    reportDefect: false,
  });
  const stop = useAtomCommand(circeEnvironment.stopComputerAccess, {
    reportFailure: false,
    reportDefect: false,
  });
  const [note, setNote] = useState<string | null>(null);
  const access: CirceComputerAccessView | null = AsyncResult.isSuccess(result)
    ? result.value
    : null;
  // What this phone shows is what a spoken yes here may answer.
  const shown = access?.pending?.id ?? null;
  useEffect(() => {
    setPresentedComputerRequest(props.nodeId, shown);
    return () => setPresentedComputerRequest(props.nodeId, null);
  }, [props.nodeId, shown]);
  if (access === null || !access.controllable) return null;
  const request = access.active ?? access.pending;
  if (request === null) return null;
  const running = access.active !== null;
  const who = request.requester.kind === "agent" ? `"${request.requester.title}"` : "You";

  const answer = (decision: "approve" | "deny") => {
    void decide({
      environmentId: props.nodeId,
      input: { requestId: request.id, decision },
    }).then((outcome) => {
      if (outcome._tag === "Success" && outcome.value.status !== "settled") {
        setNote(outcome.value.message);
      }
    });
  };

  return (
    <View className="mt-3 rounded-2xl border border-border-subtle bg-card px-4 py-3">
      <Text className="text-3xs font-t3-bold text-foreground-muted">
        {running ? "Using" : "Waiting to use"} {props.nodeLabel}'s computer
      </Text>
      <Text className="mt-1 text-sm leading-relaxed text-foreground">
        {who} asked: {request.goal}
      </Text>
      <View className="mt-3 flex-row gap-2">
        {running ? (
          <ActionButton
            label="Stop"
            onPress={() =>
              void stop({ environmentId: props.nodeId, input: { requestId: request.id } })
            }
          />
        ) : (
          <>
            <ActionButton label="Approve" primary onPress={() => answer("approve")} />
            <ActionButton label="Deny" onPress={() => answer("deny")} />
          </>
        )}
      </View>
      {note === null ? null : <Text className="mt-2 text-xs text-foreground-muted">{note}</Text>}
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly primary?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className={`flex-1 items-center rounded-xl px-3 py-2.5 active:opacity-70 ${
        props.primary === true ? "bg-circe-copper" : "border border-border-subtle"
      }`}
    >
      <Text
        className={`text-sm font-t3-bold ${props.primary === true ? "text-white" : "text-foreground"}`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
