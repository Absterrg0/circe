import { describe, expect, it } from "vite-plus/test";

import { validateScheduledSearch } from "../../routes/scheduled";
import { destinationHasPanel, resolveCirceDestination } from "./CirceNav";

describe("rail destinations", () => {
  it("resolves each page to the destination the rail lights", () => {
    expect(resolveCirceDestination("/circe")).toBe("home");
    expect(resolveCirceDestination("/pull-requests")).toBe("pulls");
    expect(resolveCirceDestination("/scheduled")).toBe("scheduled");
    expect(resolveCirceDestination("/usage")).toBe("usage");
    expect(resolveCirceDestination("/settings/connections")).toBe("settings");
    expect(resolveCirceDestination("/env-1/thread-1")).toBe("tasks");
    expect(resolveCirceDestination("/draft/abc")).toBe("tasks");
  });

  it("gives lists a panel and keeps dashboards full width", () => {
    expect(destinationHasPanel("tasks")).toBe(true);
    expect(destinationHasPanel("pulls")).toBe(true);
    expect(destinationHasPanel("scheduled")).toBe(true);
    expect(destinationHasPanel("settings")).toBe(true);
    expect(destinationHasPanel("home")).toBe(false);
    expect(destinationHasPanel("usage")).toBe(false);
  });

  it("keeps Scheduled out of Settings: old links carry their target to the new page", () => {
    expect(validateScheduledSearch({ environmentId: "env-1", taskId: "task-1" })).toEqual({
      environmentId: "env-1",
      taskId: "task-1",
    });
    expect(validateScheduledSearch({ environmentId: " ", compose: "true" })).toEqual({
      compose: true,
    });
    expect(validateScheduledSearch({ compose: "yes" })).toEqual({});
  });
});
