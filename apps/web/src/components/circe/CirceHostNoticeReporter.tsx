import type { EnvironmentId } from "@circe/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState } from "react";

import { publishCirceCommandFeedback } from "../../circeBus";
import { areCirceVoiceReportsEnabled, onCircePreferencesChanged } from "../../circePreferences";
import { circeEnvironment, circeHostOrigin, setPresentedComputerRequest } from "../../state/circe";
import { circeMeshCatalogAtom } from "../../state/circeMesh";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSessionState } from "../../state/session";
import {
  canMountCirceVoiceReporter,
  rememberBoundedPresentationId,
} from "./CirceVoiceReporter.logic";
import { playCirceSpeech } from "./circeSpeechPlayer";
import { getCirceLiveVoiceSink } from "./CirceLiveVoice.bridge";
import { speakCirceText } from "./CirceVoiceReporter";

/**
 * What the node's Circe says on its own: an agent failed, asked something,
 * needs an approval, or finished work the user is waiting on. Shown in the
 * feedback lane, and spoken when voice reports are on. Live only.
 */
export function CirceHostNoticeReporter({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const sessionState = useEnvironmentSessionState(environmentId);
  if (!canMountCirceVoiceReporter(sessionState.data)) return null;
  return <MountedNoticeReporter environmentId={environmentId} />;
}

/**
 * Notices from every node this app can reach, not only its own: a coding
 * agent on another node asking for that node's computer must be heard here.
 * Reading the catalog here keeps catalog updates from re-rendering the host.
 */
export function CirceHostNoticeReporters({
  primaryEnvironmentId,
}: {
  readonly primaryEnvironmentId: EnvironmentId;
}) {
  const catalog = useAtomValue(circeMeshCatalogAtom);
  const nodeIds = new Set<EnvironmentId>([primaryEnvironmentId]);
  for (const node of catalog?.nodes ?? []) {
    if (node.reachability === "online") nodeIds.add(node.nodeId);
  }
  return (
    <>
      {[...nodeIds].map((nodeId) => (
        <CirceHostNoticeReporter key={nodeId} environmentId={nodeId} />
      ))}
      {[...nodeIds].map((nodeId) => (
        <ComputerRequestPresence key={`computer:${nodeId}`} environmentId={nodeId} />
      ))}
    </>
  );
}

/** Keeps the request to use this node's computer that this device shows, for spoken answers. */
function ComputerRequestPresence({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(circeEnvironment.computerAccess({ environmentId, input: {} }));
  const shown = AsyncResult.isSuccess(result) ? (result.value.pending?.id ?? null) : null;
  useEffect(() => {
    setPresentedComputerRequest(environmentId, shown);
    return () => setPresentedComputerRequest(environmentId, null);
  }, [environmentId, shown]);
  return null;
}

function MountedNoticeReporter({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(
    circeEnvironment.hostNotices({ environmentId, input: { origin: circeHostOrigin } }),
  );
  const seen = useRef(new Set<string>());
  const speakWithNode = useAtomCommand(circeEnvironment.hostSpeak, {
    reportFailure: false,
    reportDefect: false,
  });
  const [speak, setSpeak] = useState(areCirceVoiceReportsEnabled);
  useEffect(() => onCircePreferencesChanged(() => setSpeak(areCirceVoiceReportsEnabled())), []);

  useEffect(() => {
    if (!AsyncResult.isSuccess(result)) return;
    const notice = result.value;
    if (!rememberBoundedPresentationId(seen.current, notice.id)) return;
    publishCirceCommandFeedback({ inputMode: "text", kind: "done", text: notice.text });
    if (!speak) return;
    // A live conversation voices it; otherwise Circe's own voice through
    // Circe Mesh, or the system voice when the node has none.
    if (getCirceLiveVoiceSink() !== null) {
      void speakCirceText(notice.text, notice.id);
      return;
    }
    void speakWithNode({ environmentId, input: { text: notice.text.slice(0, 4_000) } }).then(
      async (spoken) => {
        if (spoken._tag === "Success" && spoken.value.audio.length > 0) {
          await playCirceSpeech(spoken.value.audio);
        } else {
          await speakCirceText(notice.text, notice.id);
        }
      },
    );
  }, [environmentId, result, speak, speakWithNode]);

  return null;
}
