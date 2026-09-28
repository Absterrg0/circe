import { Link } from "@tanstack/react-router";

import { isElectron } from "../env";
import { CIRCE_MARK_SRC } from "./circe/CirceBrand";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-xs text-muted-foreground">No active thread</span>
        </WorkspacePageHeader>

        <Empty className="flex-1">
          <div className="flex w-full max-w-md flex-col items-center px-8 py-12 text-center">
            <img alt="" className="size-12 rounded-xl" src={CIRCE_MARK_SRC} />
            <EmptyHeader className="mt-6 max-w-none">
              <EmptyTitle className="font-display text-xl font-semibold tracking-[-0.015em] text-foreground">
                Pick up where you left off
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Choose a bot, chat, or agent from the sidebar, or tell Circe what you want done and
                it finds the right machine.
              </EmptyDescription>
            </EmptyHeader>
            <Button className="mt-6" render={<Link to="/circe" />}>
              Open overview
            </Button>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
