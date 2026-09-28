import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@circe/contracts";
import { memo } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ComposerPendingApprovalActionsProps {
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "decline", label: "Deny" },
  { decision: "acceptForSession", label: "Allow for this task" },
  { decision: "accept", label: "Allow once" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

const APPROVAL_ACTION_CLASS_NAME = "font-medium";

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  canRespond,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  return (
    <>
      {options.map((option) => {
        const button = (
          <Button
            key={option.decision}
            size="xs"
            variant={
              option.decision === "accept"
                ? "default"
                : option.decision === "decline"
                  ? "ghost"
                  : "outline"
            }
            className={cn(
              APPROVAL_ACTION_CLASS_NAME,
              option.decision === "decline" &&
                "bg-danger-soft text-danger [:hover,[data-pressed]]:bg-danger-soft [:hover,[data-pressed]]:text-danger [:hover,[data-pressed]]:ring-1 [:hover,[data-pressed]]:ring-danger/50",
              option.warning && option.decision !== "decline" && "text-attention",
            )}
            disabled={isResponding || !canRespond}
            aria-description={option.warning}
            onClick={() => void onRespondToApproval(requestId, option.decision)}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-44 truncate">{option.label}</span>
          </Button>
        );
        // A provider caution, such as a prompt injection warning on "allow
        // always", rides along as a tooltip so the row stays one line.
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top" className="max-w-72 text-xs leading-snug">
              {option.warning}
            </TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
    </>
  );
});
