import type { CirceComputerStatus, EnvironmentId } from "@circe/contracts";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@circe/client/state/runtime";
import { MonitorIcon, OctagonIcon, PlayIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import { randomUUID } from "../../lib/utils";
import { circeMeshEnvironment } from "../../state/circeMesh";
import { useAtomCommand } from "../../state/use-atom-command";

import "./CirceComputerSection.css";

/**
 * Computer use for one node. The node's desktop host owns the OS session; this
 * panel only starts and stops user-authorized missions and renders the live
 * status. A mission started here runs on the node and keeps running if this
 * view closes, so Stop is the way to end it.
 */
export function CirceComputerSection({
  environmentId,
  online,
}: {
  readonly environmentId: EnvironmentId;
  readonly online: boolean;
}) {
  const getStatus = useAtomCommand(circeMeshEnvironment.computerStatus, {
    reportFailure: false,
    reportDefect: false,
  });
  const startMission = useAtomCommand(circeMeshEnvironment.computerUse, {
    reportFailure: false,
    reportDefect: false,
  });
  const cancelMission = useAtomCommand(circeMeshEnvironment.cancelComputerMission, {
    reportFailure: false,
    reportDefect: false,
  });
  const [status, setStatus] = useState<CirceComputerStatus | null>(null);
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // The request id we minted for the mission this panel started. It is set
  // before the start RPC resolves so Stop is usable immediately, independent
  // of the start submission.
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!online) return;
    const current = ++generation.current;
    const result = await getStatus({ nodeId: environmentId });
    if (current !== generation.current) return;
    if (result._tag === "Success") {
      setStatus(result.value);
    } else if (!isAtomCommandInterrupted(result)) {
      setStatus(null);
    }
  }, [environmentId, getStatus, online]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  // A running mission is the only state that changes on its own; poll while
  // one exists, or while this panel is waiting for its own start to appear.
  useEffect(() => {
    if (status?.activeMission === undefined && activeRequestId === null) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [refresh, status?.activeMission, activeRequestId]);

  const start = () => {
    const trimmed = goal.trim();
    if (trimmed.length === 0 || submitting) return;
    const requestId = randomUUID();
    setSubmitting(true);
    setActiveRequestId(requestId);
    setMessage(null);
    setFailed(false);
    setGoal("");
    void refresh();
    void startMission({
      nodeId: environmentId,
      input: {
        goal: trimmed,
        confirmed: true,
        requestMetadata: { requestId },
      },
    }).then((result) => {
      setSubmitting(false);
      setActiveRequestId(null);
      if (result._tag === "Success") {
        setMessage(result.value.message);
        setFailed(result.value.status === "refused" || result.value.status === "unavailable");
      } else if (!isAtomCommandInterrupted(result)) {
        setMessage(String(squashAtomCommandFailure(result)));
        setFailed(true);
      }
      void refresh();
    });
  };

  const stop = () => {
    const requestId = activeRequestId ?? status?.activeMission?.requestId;
    if (requestId === undefined) return;
    void cancelMission({ nodeId: environmentId, input: { requestId } }).then(() => {
      setActiveRequestId(null);
      void refresh();
    });
  };

  const activeMission = status?.activeMission;
  const missionRunning = activeMission !== undefined || activeRequestId !== null;
  const available = status?.available === true;
  const stateLabel = !online
    ? "Offline"
    : missionRunning
      ? "Working"
      : status === null
        ? "Checking…"
        : available
          ? "Ready"
          : "Unavailable";

  return (
    <section className="circe-computer">
      <div className="circe-section-heading">
        <h3>
          <MonitorIcon className="size-3.5" aria-hidden /> Computer
        </h3>
        <span
          className={`circe-computer-state ${
            missionRunning ? "is-working" : available && online ? "is-ready" : "is-unavailable"
          }`}
        >
          {stateLabel}
        </span>
      </div>

      {!online ? (
        <p className="circe-muted-note">This node is offline.</p>
      ) : status === null && !missionRunning ? (
        <p className="circe-muted-note">Reading desktop status…</p>
      ) : status !== null && status.reason !== undefined && !available && !missionRunning ? (
        <p className="circe-muted-note">{status.reason}</p>
      ) : missionRunning ? (
        <>
          <p className="circe-computer-goal">{activeMission?.goal ?? "Starting the mission…"}</p>
          <p className="circe-muted-note">
            The mission runs on this node. Stop ends it at the next safe point.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={stop}>
            <OctagonIcon className="size-3.5" /> Stop
          </Button>
        </>
      ) : (
        <>
          <div className="circe-computer-row">
            <input
              className="circe-computer-input"
              value={goal}
              placeholder="What should it do on this desktop?"
              disabled={!available || submitting}
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") start();
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!available || submitting || goal.trim().length === 0}
              onClick={start}
            >
              <PlayIcon className="size-3.5" /> Start
            </Button>
          </div>
          <p className="circe-muted-note">
            {available
              ? "One mission at a time. Actions are grounded against the real window and audited."
              : "Start the Circe desktop app on this node to enable computer use."}
          </p>
        </>
      )}

      {message !== null ? (
        <p className={`circe-computer-message ${failed ? "is-error" : ""}`}>{message}</p>
      ) : null}
    </section>
  );
}
