import { ChevronDownIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import "../circe/circe-surfaces.css";

/**
 * One of the sidebar's top-level groups: Bots, Chats, Agents. The label
 * toggles the group; an optional action sits at the end of the row.
 */
export function SidebarSectionHeading(props: {
  readonly label: string;
  readonly count?: number | null;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  /** Controls that belong to the group, shown before its action. */
  readonly accessory?: ReactNode;
  readonly action?: {
    readonly label: string;
    readonly icon: ReactNode;
    readonly onClick: (event: ReactMouseEvent) => void;
    readonly disabled?: boolean;
  };
}) {
  return (
    <li
      className="circe-sidebar-section"
      data-collapsed={props.collapsed ? "true" : "false"}
      data-testid={`sidebar-section-${props.label.toLowerCase()}`}
    >
      <button
        type="button"
        className="circe-sidebar-section__toggle"
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
      >
        <span>{props.label}</span>
        {props.count != null && props.count > 0 ? (
          <span className="circe-sidebar-section__count">{props.count}</span>
        ) : null}
        <ChevronDownIcon aria-hidden className="circe-sidebar-section__chevron" />
      </button>
      {props.accessory}
      {props.action ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="circe-sidebar-section__action"
                aria-label={props.action.label}
                disabled={props.action.disabled}
                onClick={props.action.onClick}
              />
            }
          >
            {props.action.icon}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.action.label}</TooltipPopup>
        </Tooltip>
      ) : null}
    </li>
  );
}
