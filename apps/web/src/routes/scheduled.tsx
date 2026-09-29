import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ScheduledTaskId } from "@circe/contracts";

import { ScheduledTasksPage } from "../components/scheduled/ScheduledTasksPage";

export interface ScheduledSearch {
  readonly environmentId?: EnvironmentId;
  readonly taskId?: ScheduledTaskId;
  /** One-shot: open the editor for a new schedule on `environmentId`. */
  readonly compose?: boolean;
}

export function validateScheduledSearch(raw: Record<string, unknown>): ScheduledSearch {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
    ...(raw.compose === true || raw.compose === "true" ? { compose: true } : {}),
  };
}

function ScheduledRoute() {
  const target = Route.useSearch();
  return <ScheduledTasksPage {...target} />;
}

export const Route = createFileRoute("/scheduled")({
  validateSearch: validateScheduledSearch,
  component: ScheduledRoute,
});
