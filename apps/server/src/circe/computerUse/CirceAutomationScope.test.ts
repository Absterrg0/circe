import { EnvironmentId, ThreadId } from "@circe/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { circeAutomationScope } from "./CirceAutomationScope.ts";

const build = () =>
  circeAutomationScope({
    environmentId: EnvironmentId.make("node-1"),
    threadId: ThreadId.make("thread-1"),
    controlSessionId: "session-abc",
  });

describe("Circe automation scope", () => {
  it.effect("builds a stable Circe-owned session identity with preview capabilities", () =>
    Effect.gen(function* () {
      const scope = yield* build();
      expect(scope.providerSessionId).toBe("circe-control:session-abc");
      expect(scope.capabilities.has("preview")).toBe(true);
      expect(scope.capabilities.has("desktop-use")).toBe(true);
      expect(scope.capabilities.has("orchestration")).toBe(false);
      expect(scope.environmentId).toBe(EnvironmentId.make("node-1"));
      expect(scope.threadId).toBe(ThreadId.make("thread-1"));
    }),
  );

  it.effect("keeps the session id stable so host stickiness survives across operations", () =>
    Effect.gen(function* () {
      const first = yield* build();
      const second = yield* build();
      expect(first.providerSessionId).toBe(second.providerSessionId);
    }),
  );
});
