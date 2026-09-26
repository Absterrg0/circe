import { Link } from "@tanstack/react-router";

import { isElectron } from "../env";
import { CirceOrb } from "./circe/CirceOrb";
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
            <CirceOrb size="xl" />
            <EmptyHeader className="mt-7 max-w-none">
              <EmptyTitle className="text-xl font-semibold tracking-tight text-foreground">
                Pick up where you left off
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Choose a bot, chat, or agent from the sidebar, or tell Circe what you want done and
                it finds the right machine.
              </EmptyDescription>
            </EmptyHeader>
            <Button className="mt-6 rounded-full px-5" render={<Link to="/circe" />}>
              Open command center
            </Button>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
