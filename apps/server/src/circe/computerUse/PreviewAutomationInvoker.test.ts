import { EnvironmentId, ThreadId, type PreviewAutomationSnapshot } from "@circe/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { circeAutomationScope } from "./CirceAutomationScope.ts";
import {
  makePreviewAutomationInvoker,
  type PreviewAutomationInvoke,
} from "./PreviewAutomationInvoker.ts";

const fullSnapshot: PreviewAutomationSnapshot = {
  url: "https://mail.example.com",
  title: "Inbox",
  loading: false,
  visibleText: "Compose",
  interactiveElements: [
    {
      tag: "button",
      role: "button",
      name: "Compose",
      selector: "role=button[name='Compose']",
      x: 1,
      y: 2,
      width: 30,
      height: 12,
    },
  ],
  accessibilityTree: null,
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: { mimeType: "image/png", data: "", width: 100, height: 100 },
};

describe("preview automation invoker", () => {
  it("maps a grounded snapshot and a selector operation onto the broker", () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    const invoke: PreviewAutomationInvoke = <A>(request: {
      operation: string;
      input: unknown;
    }): Effect.Effect<A, never> => {
      requests.push(request);
      if (request.operation === "snapshot") return Effect.succeed(fullSnapshot as A);
      return Effect.succeed(undefined as A);
    };
    const scope = Effect.runSync(
      circeAutomationScope({
        environmentId: EnvironmentId.make("node-1"),
        threadId: ThreadId.make("thread-1"),
        controlSessionId: "session-abc",
      }),
    );
    const invoker = makePreviewAutomationInvoker({ invoke, scope });

    const surface = Effect.runSync(invoker.snapshot());
    expect(surface.title).toBe("Inbox");
    expect(surface.interactiveElements).toHaveLength(1);

    Effect.runSync(
      invoker.apply({
        operation: "click",
        input: { locator: "role=button[name='Compose']" },
      }),
    );
    expect(requests.map((request) => request.operation)).toEqual(["snapshot", "click"]);
    expect(requests[1]?.input).toEqual({ locator: "role=button[name='Compose']" });
  });
});
