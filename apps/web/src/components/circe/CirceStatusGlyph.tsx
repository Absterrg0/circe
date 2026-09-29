import type { SidebarThreadStatus } from "../Sidebar.logic";

export type CirceTone = "running" | "attention" | "failed" | "done" | "idle";

/** The tone a task status reads in: color, glyph, and label agree. */
export function toneForTaskStatus(status: SidebarThreadStatus): CirceTone {
  switch (status) {
    case "working":
      return "running";
    case "approval":
    case "input":
      return "attention";
    case "failed":
      return "failed";
    case "ready":
      return "done";
    case "waiting":
      return "idle";
  }
}

/**
 * A ring that says how a task stands without relying on color alone: an open
 * arc while it runs, a held dot when it needs you, a bar for failure, a check
 * when done, and a dashed ring while it waits. Static, so a long list costs
 * no frames.
 */
export function CirceStatusGlyph({
  tone,
  label,
}: {
  readonly tone: CirceTone;
  readonly label: string;
}) {
  return (
    <svg
      className="circe-status-glyph"
      data-tone={tone}
      viewBox="0 0 18 18"
      fill="none"
      role="img"
      aria-label={label}
    >
      {tone === "running" ? (
        <>
          <circle cx="9" cy="9" r="7" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
          <path
            d="M9 2a7 7 0 1 1-7 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      ) : tone === "idle" ? (
        <circle
          cx="9"
          cy="9"
          r="7"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeDasharray="2.6 2.4"
        />
      ) : (
        <>
          <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.75" />
          {tone === "attention" ? <circle cx="9" cy="9" r="2.6" fill="currentColor" /> : null}
          {tone === "failed" ? (
            <path
              d="M9 5.4v4.2M9 12.3v.3"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            />
          ) : null}
          {tone === "done" ? (
            <path
              d="m5.9 9.2 2.1 2.1 4.1-4.3"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : null}
        </>
      )}
    </svg>
  );
}
