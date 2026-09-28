import type { StatusTone } from "../../components/StatusPill";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "@circe/client/state/shell";

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "error"
  | "plan-ready";

export interface ThreadStatusPresentation extends StatusTone {
  readonly kind: ThreadStatusKind;
  /** Foreground color for the leading status icon. */
  readonly iconColor: string;
  /** Background color for the leading status icon circle. */
  readonly iconBackground: string;
  /** Whether the indicator represents in-flight activity. */
  readonly pulse: boolean;
}

function isLatestRunSettled(thread: EnvironmentThreadShell): boolean {
  if (!thread.latestRun?.startedAt) return false;
  if (!thread.latestRun.completedAt) return false;
  return !threadRuntimeIsActive(thread.runtime);
}

/**
 * Resolves the user-facing status of a thread, in priority order. Returns
 * `null` for quiescent threads so rows stay free of "Idle"-style noise.
 * Mirrors `resolveThreadStatusPill` in apps/web/src/components/Sidebar.logic.ts.
 */
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  // Circe's fixed status words and signal colors: gold for anything that
  // needs the user, ember for running work, danger for failures.
  const needsYou = {
    label: "Needs you",
    pillClassName: "bg-circe-attention-soft",
    textClassName: "text-circe-attention",
    iconColor: "#d9a441",
    iconBackground: "rgba(217,164,65,0.22)",
    pulse: false,
  } as const;
  if (thread.hasPendingApprovals) {
    return { kind: "pending-approval", ...needsYou };
  }

  if (thread.hasPendingUserInput) {
    return { kind: "awaiting-input", ...needsYou };
  }

  const runtimeStatus = thread.runtime?.status;

  if (runtimeStatus === "running" || runtimeStatus === "waiting") {
    return {
      kind: "working",
      label: "Running",
      pillClassName: "bg-circe-blush",
      textClassName: "text-circe-copper",
      iconColor: "#e18a62",
      iconBackground: "rgba(225,138,98,0.22)",
      pulse: true,
    };
  }

  if (runtimeStatus === "preparing" || runtimeStatus === "queued" || runtimeStatus === "starting") {
    return {
      kind: "connecting",
      label: "Queued",
      pillClassName: "bg-subtle",
      textClassName: "text-foreground-secondary",
      iconColor: "#8f877e",
      iconBackground: "rgba(143,135,126,0.22)",
      pulse: true,
    };
  }

  if (runtimeStatus === "failed" || thread.latestRun?.status === "failed") {
    return {
      kind: "error",
      label: "Failed",
      pillClassName: "bg-circe-danger-soft",
      textClassName: "text-circe-danger",
      iconColor: "#e0584b",
      iconBackground: "rgba(224,88,75,0.22)",
      pulse: false,
    };
  }

  const hasPlanReadyPrompt =
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return { kind: "plan-ready", ...needsYou, label: "Plan ready" };
  }

  return null;
}
