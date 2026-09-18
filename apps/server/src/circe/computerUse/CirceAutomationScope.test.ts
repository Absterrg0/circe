import { EnvironmentId, ThreadId } from "@circe/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { circeAutomationScope } from "./CirceAutomationScope.ts";

const build = () =>
  Effect.runSync(
    circeAutomationScope({
      environmentId: EnvironmentId.make("node-1"),
      threadId: ThreadId.make("thread-1"),
      controlSessionId: "session-abc",
    }),
  );

describe("Circe automation scope", () => {
  it("builds a stable Circe-owned session identity with preview capabilities", () => {
    const scope = build();
    expect(scope.providerSessionId).toBe("circe-control:session-abc");
    expect(scope.capabilities.has("preview")).toBe(true);
    expect(scope.capabilities.has("desktop-use")).toBe(true);
    expect(scope.capabilities.has("orchestration")).toBe(false);
    expect(scope.environmentId).toBe(EnvironmentId.make("node-1"));
    expect(scope.threadId).toBe(ThreadId.make("thread-1"));
  });

  it("keeps the session id stable so host stickiness survives across operations", () => {
    expect(build().providerSessionId).toBe(build().providerSessionId);
  });
});
