import type {
  CirceComputerAccessView,
  CirceComputerRequestView,
  EnvironmentId,
} from "@circe/contracts";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@circe/client/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, MonitorIcon, OctagonIcon, PlayIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../ui/button";
import { randomUUID } from "../../lib/utils";
import { circeEnvironment } from "../../state/circe";
import { circeMeshEnvironment } from "../../state/circeMesh";
import { useAtomCommand } from "../../state/use-atom-command";

import "./CirceComputerSection.css";

/**
 * Computer use for one node. The node owns who uses its computer: this panel
 * renders that state as the node reports it, so a request Circe or a coding
 * agent is waiting on shows here with its own Approve and Deny, on every
 * device, after a reload too. A run started here belongs to the node and
 * keeps running if this view closes, so Stop is the way to end it.
 */
export function CirceComputerSection({
  environmentId,
  online,
}: {
  readonly environmentId: EnvironmentId;
  readonly online: boolean;
}) {
  if (!online) {
    return (
      <ComputerFrame stateLabel="Offline" tone="is-unavailable">
        <p className="circe-muted-note">This node is offline.</p>
      </ComputerFrame>
    );
  }
  return <OnlineComputerSection environmentId={environmentId} />;
}

function OnlineComputerSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const accessResult = useAtomValue(circeEnvironment.computerAccess({ environmentId, input: {} }));
  const access: CirceComputerAccessView | null = AsyncResult.isSuccess(accessResult)
    ? accessResult.value
    : null;
  const startMission = useAtomCommand(circeMeshEnvironment.computerUse, {
    reportFailure: false,
    reportDefect: false,
  });
  const decide = useAtomCommand(circeEnvironment.decideComputerAccess, {
    reportFailure: false,
    reportDefect: false,
  });
  const stopAccess = useAtomCommand(circeEnvironment.stopComputerAccess, {
    reportFailure: false,
    reportDefect: false,
  });
  const [goal, setGoal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const report = (text: string, isError: boolean) => {
    setMessage(text);
    setFailed(isError);
  };

  const start = () => {
    const trimmed = goal.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    setMessage(null);
    setGoal("");
    // Run is the approval: the node starts it through the same owner Circe
    // and coding agents use.
    void startMission({
      nodeId: environmentId,
      input: { goal: trimmed, confirmed: true, requestMetadata: { requestId: randomUUID() } },
    }).then((result) => {
      setSubmitting(false);
      if (result._tag === "Success") {
        report(
          result.value.message,
          result.value.status === "refused" || result.value.status === "unavailable",
        );
      } else if (!isAtomCommandInterrupted(result)) {
        report(String(squashAtomCommandFailure(result)), true);
      }
    });
  };

  const answer = (request: CirceComputerRequestView, decision: "approve" | "deny") => {
    void decide({ environmentId, input: { requestId: request.id, decision } }).then((result) => {
      if (result._tag === "Success") {
        if (result.value.status !== "settled") report(result.value.message, true);
      } else if (!isAtomCommandInterrupted(result)) {
        report(String(squashAtomCommandFailure(result)), true);
      }
    });
  };

  const stop = (requestId: string) => {
    void stopAccess({ environmentId, input: { requestId } }).then((result) => {
      if (result._tag === "Success" && !result.value.stopped) {
        report("That had already finished.", false);
      }
    });
  };

  const pending = access?.pending ?? null;
  const active = access?.active ?? null;
  const available = access?.available === true;
  const stateLabel =
    active !== null
      ? "Working"
      : pending !== null
        ? "Waiting for you"
        : access === null
          ? "Checking…"
          : available
            ? "Ready"
            : "Unavailable";
  const tone =
    active !== null || pending !== null ? "is-working" : available ? "is-ready" : "is-unavailable";

  return (
    <ComputerFrame stateLabel={stateLabel} tone={tone}>
      {access !== null && !access.controllable ? (
        <p className="circe-muted-note">This node has no desktop to control.</p>
      ) : active !== null ? (
        <>
          <p className="circe-computer-goal">{active.goal}</p>
          <p className="circe-muted-note">
            {requesterLine(active, "Using the computer")} It stops at the next safe point.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => stop(active.id)}>
            <OctagonIcon className="size-3.5" /> Stop
          </Button>
        </>
      ) : pending !== null ? (
        <>
          <p className="circe-computer-goal">{pending.goal}</p>
          <p className="circe-muted-note">{requesterLine(pending, "Waiting for your answer")}</p>
          <div className="circe-computer-row">
            <Button type="button" size="sm" onClick={() => answer(pending, "approve")}>
              <CheckIcon className="size-3.5" /> Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => answer(pending, "deny")}
            >
              <XIcon className="size-3.5" /> Deny
            </Button>
          </div>
        </>
      ) : access !== null && !available ? (
        <p className="circe-muted-note">
          {access.reason ?? "Start the Circe desktop app on this node to enable computer use."}
        </p>
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
            One thing uses the computer at a time. Actions are grounded against the real window and
            audited.
          </p>
          {access?.limitation === undefined ? null : (
            <p className="circe-muted-note">{access.limitation}</p>
          )}
        </>
      )}

      {message !== null ? (
        <p className={`circe-computer-message ${failed ? "is-error" : ""}`}>{message}</p>
      ) : active === null && pending === null && access?.last != null ? (
        <p
          className={`circe-computer-message ${
            access.last.outcome === "failed" || access.last.outcome === "uncertain"
              ? "is-error"
              : ""
          }`}
        >
          {access.last.message}
        </p>
      ) : null}
    </ComputerFrame>
  );
}

function requesterLine(request: CirceComputerRequestView, verb: string): string {
  return request.requester.kind === "agent"
    ? `${verb}: asked by "${request.requester.title}".`
    : `${verb}.`;
}

function ComputerFrame(props: {
  readonly stateLabel: string;
  readonly tone: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="circe-computer">
      <div className="circe-section-heading">
        <h3>
          <MonitorIcon className="size-3.5" aria-hidden /> Computer
        </h3>
        <span className={`circe-computer-state ${props.tone}`}>{props.stateLabel}</span>
      </div>
      {props.children}
    </section>
  );
}
