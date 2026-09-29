import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateScheduledSearch } from "./scheduled";

// Schedules moved out of Settings into their own page. Old links, including
// "open this schedule" links in task timelines, keep working.
export const Route = createFileRoute("/settings/scheduled-tasks")({
  validateSearch: validateScheduledSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/scheduled", search, replace: true });
  },
});
