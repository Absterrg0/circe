/**
 * The sidebar header: search across everything, and one New menu for the
 * three kinds of work (a chat, an agent thread in a project, a new project).
 * Project scope lives with the Agents group it filters, not up here.
 */
import {
  FolderPlusIcon,
  MessageCircleIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  /** Lands on the search field so a popup can anchor to its width. */
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  /** Null when no node offers a chat space yet. */
  onNewChat: (() => void) | null;
  onNewAgentThread: () => void;
  newAgentThreadDisabled: boolean;
  newAgentThreadShortcutLabel: string | null | undefined;
  onAddProject: () => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchFieldRef,
  onNewChat,
  onNewAgentThread,
  newAgentThreadDisabled,
  newAgentThreadShortcutLabel,
  onAddProject,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;

  return (
    <div className="flex items-center gap-1">
      <div
        ref={searchFieldRef}
        className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <SearchIcon className="size-4 shrink-0 text-[var(--sidebar-icon-color)]" />
        <Input
          ref={searchInputRef}
          nativeInput
          unstyled
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search"
          aria-label="Search threads"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
          aria-activedescendant={
            activeResultExists
              ? `sidebar-thread-search-result-${activeSearchResultIndex}`
              : undefined
          }
          className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-sidebar-foreground [&_[data-slot=input]]:placeholder:text-[var(--sidebar-icon-color)]"
        />
        {isSearching ? (
          <Button
            type="button"
            size="icon-micro"
            variant="ghost"
            className="shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-control-surface hover:text-sidebar-foreground"
            aria-label="Clear thread search"
            onClick={() => {
              onClearSearch();
              searchInputRef.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </div>
      <Menu>
        <MenuTrigger render={<SidebarHeaderIconButton label="New" />}>
          <PlusIcon />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          {onNewChat !== null ? (
            <MenuItem onClick={onNewChat}>
              <MessageCircleIcon />
              New chat
            </MenuItem>
          ) : null}
          <MenuItem disabled={newAgentThreadDisabled} onClick={onNewAgentThread}>
            <SquarePenIcon />
            <span className="flex-1">New agent thread</span>
            {newAgentThreadShortcutLabel ? (
              <span className="text-xs text-muted-foreground">{newAgentThreadShortcutLabel}</span>
            ) : null}
          </MenuItem>
          <MenuItem onClick={onAddProject}>
            <FolderPlusIcon />
            Add project
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

/**
 * Icon button with a tooltip, sized for the header's segmented pair. Spreads
 * unknown props through so it can serve as a popup trigger's render target,
 * which injects its own handlers, ref and aria state.
 */
export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  /** Accessible name; also the tooltip unless `tooltip` says more. */
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn(
              "relative size-7 shrink-0 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
              className,
            )}
          />
        }
      >
        {children}
        {/* Coarse-pointer hit area, matching the rest of the sidebar chrome. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
