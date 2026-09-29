import type { EnvironmentId, ScheduledTask, ScheduledTaskSchedule } from "@circe/contracts";

import { formatRelativeTime } from "../../timestampFormat";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function scheduleLabel(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "interval") {
    const minutes = schedule.everyMs / 60_000;
    return Number.isInteger(minutes)
      ? `Every ${minutes} min`
      : `Every ${Math.round(schedule.everyMs / 1000)} sec`;
  }
  const weekdays = schedule.weekdays ?? [];
  const days =
    weekdays.length === 0
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

/**
 * Human label for a run timestamp. `formatRelativeTime` only handles the
 * past, and `nextRunAt` is a future instant — render "in 5m" style labels
 * for upcoming runs instead of a misleading "just now".
 */
export function relativeLabel(value: string | null): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export const LAST_RUN_WORDS: Readonly<Record<ScheduledTask["lastRunStatus"], string>> = {
  never: "Not run yet",
  running: "Running…",
  succeeded: "Last run finished",
  failed: "Last run failed",
};

export function useScheduledTasks(environmentId: EnvironmentId | null) {
  // Live subscription: the server pushes a fresh list after every change
  // (CRUD, run transitions, reschedules), so no manual refresh is needed.
  return useEnvironmentQuery(
    environmentId ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
}
