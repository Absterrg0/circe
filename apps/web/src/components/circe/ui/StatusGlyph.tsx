import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

import "./circe-ui.css";

/**
 * Circe's fixed status vocabulary. The word is used verbatim in badges,
 * sections and speech; the glyph pairs with it so color is never the only
 * signal. Heat means urgency: settled work is faint, running work is ember,
 * work that needs the user is the attention gold.
 */
export type CirceTaskState =
  | "running"
  | "queued"
  | "needs"
  | "done"
  | "failed"
  | "offline"
  | "settled"
  | "speaking";

export const CIRCE_STATUS_WORD: Readonly<Record<CirceTaskState, string>> = {
  running: "Running",
  queued: "Queued",
  needs: "Needs you",
  done: "Completed",
  failed: "Failed",
  offline: "Offline",
  settled: "Settled",
  speaking: "Speaking",
};

export function StatusGlyph({
  state,
  size = 14,
  label,
  className,
}: {
  readonly state: CirceTaskState;
  readonly size?: number;
  /** Accessible name. Omit when a visible status word sits next to the glyph. */
  readonly label?: string;
  readonly className?: string;
}) {
  const a11y = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true } as const);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={cn("ci-glyph", `ci-glyph--${state}`, className)}
      {...a11y}
    >
      {state === "running" ? (
        <>
          <circle
            cx="8"
            cy="8"
            r="5.5"
            fill="none"
            stroke="var(--ember)"
            strokeOpacity=".35"
            strokeWidth="1.5"
          />
          <g className="ci-glyph__orbit">
            <circle cx="8" cy="2.5" r="2.25" fill="var(--ember)" />
          </g>
          <circle cx="8" cy="8" r="1.75" fill="var(--ember)" />
        </>
      ) : state === "queued" ? (
        <circle
          cx="8"
          cy="8"
          r="5.5"
          fill="none"
          stroke="var(--line-strong)"
          strokeWidth="1.5"
          strokeDasharray="2.2 2.1"
        />
      ) : state === "needs" ? (
        <>
          <circle cx="8" cy="8" r="7" fill="var(--attention)" fillOpacity=".22" />
          <circle cx="8" cy="8" r="4" fill="var(--attention)" />
        </>
      ) : state === "done" ? (
        <>
          <circle cx="8" cy="8" r="6.5" fill="var(--success)" />
          <path
            d="M5.2 8.3l1.9 1.9 3.8-4.1"
            fill="none"
            stroke="var(--canvas)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : state === "failed" ? (
        <>
          <circle cx="8" cy="8" r="6.5" fill="var(--danger)" />
          <path
            d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"
            stroke="var(--canvas)"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </>
      ) : state === "offline" ? (
        <>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="var(--ink-faint)" strokeWidth="1.5" />
          <path d="M4 12L12 4" stroke="var(--ink-faint)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : state === "settled" ? (
        <circle cx="8" cy="8" r="3" fill="var(--ink-faint)" />
      ) : (
        <>
          <rect
            className="ci-glyph__bar"
            x="2.5"
            y="5.5"
            width="2.2"
            height="5"
            rx="1.1"
            fill="var(--voice)"
          />
          <rect
            className="ci-glyph__bar"
            x="6.9"
            y="2.5"
            width="2.2"
            height="11"
            rx="1.1"
            fill="var(--voice)"
          />
          <rect
            className="ci-glyph__bar"
            x="11.3"
            y="4.5"
            width="2.2"
            height="7"
            rx="1.1"
            fill="var(--voice)"
          />
        </>
      )}
    </svg>
  );
}

/** A glyph with its status word; `inline` drops the soft ground for prose and rows. */
export function StatusBadge({
  state,
  label = CIRCE_STATUS_WORD[state],
  inline = false,
  className,
}: {
  readonly state: CirceTaskState;
  readonly label?: string;
  readonly inline?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn("ci-status", `ci-status--${state}`, inline && "ci-status--inline", className)}
    >
      <StatusGlyph state={state} size={inline ? 14 : 12} />
      <span>{label}</span>
    </span>
  );
}

export type CircePresenceState = "online" | "busy" | "offline";

export function Presence({
  state,
  ring,
  className,
}: {
  readonly state: CircePresenceState;
  /** The ground the dot sits on, so its cut-out ring matches. */
  readonly ring?: string;
  readonly className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={state}
      className={cn("ci-presence", `ci-presence--${state}`, className)}
      style={ring ? ({ "--presence-ring": ring } as CSSProperties) : undefined}
    />
  );
}
