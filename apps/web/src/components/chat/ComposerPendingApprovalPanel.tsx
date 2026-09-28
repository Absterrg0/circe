import { describeApproval } from "@circe/core/describeApproval";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  projectTitle: string;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  projectTitle,
  className,
}: ComposerPendingApprovalPanelProps) {
  const fallbackLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : "File change approval";
  const detailAriaLabel =
    approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : "File change";
  const description = describeApproval({
    requestKind: approval.requestKind,
    ...(approval.detail === undefined ? {} : { detail: approval.detail }),
    projectTitle,
  });
  const riskLabel =
    description.risk === "destructive"
      ? "Permanent action"
      : description.risk === "external-effect"
        ? "External action"
        : description.risk === "workspace-write"
          ? "Changes files"
          : description.risk === "read-and-compute"
            ? "Runs locally"
            : description.risk === "read"
              ? "Reads only"
              : "Review carefully";
  const decisionSummary =
    approval.requestKind === "mcp-elicitation" && approval.detail
      ? approval.detail
      : description.spoken;

  return (
    <div aria-label={fallbackLabel} className={cn("min-w-0 text-left", className)} role="group">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-display text-[11px] font-medium uppercase tracking-[0.2em] text-attention">
          Needs you
        </span>
        <span className="min-w-0 text-[13px] leading-[18px] text-ink-muted">{decisionSummary}</span>
        <span className="rounded-sm bg-attention-soft px-1.5 py-0.5 text-[10.5px] font-medium text-attention">
          {riskLabel}
        </span>
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-faint tabular-nums">
            1 of {pendingCount}
          </span>
        ) : null}
      </div>
      {approval.appName ? (
        <span className="mt-2 block max-w-40 shrink truncate text-xs font-medium text-foreground">
          {approval.appName}
        </span>
      ) : null}
      {/* A person cannot approve what they cannot read: the full request,
          wrapped, never truncated. Very long requests scroll inside the well. */}
      <code
        aria-label={detailAriaLabel}
        className="mt-2.5 flex max-h-64 min-w-0 w-full gap-2.5 overflow-auto rounded-md border border-line bg-well px-3 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[12.5px] leading-5 text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        data-approval-detail="complete"
        tabIndex={0}
      >
        {approval.requestKind === "command" && approval.responseCapability !== "not_resumable" ? (
          <span aria-hidden className="select-none text-ink-faint">
            $
          </span>
        ) : null}
        <span className="min-w-0">
          {approval.responseCapability === "not_resumable"
            ? "Provider process is gone — interrupt or restart the run to respond."
            : approval.detail || fallbackLabel}
        </span>
      </code>
    </div>
  );
});
