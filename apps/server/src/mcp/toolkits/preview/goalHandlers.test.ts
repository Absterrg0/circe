import { EnvironmentId, ProviderInstanceId, ThreadId } from "@circe/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { CirceBrowserUse } from "../../../circe/Services/CirceBrowserUse.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PreviewGoalToolkitHandlersLive } from "./handlers.ts";
import { PreviewGoalToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-browser-goal");
const environmentId = EnvironmentId.make("environment-browser-goal");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId: THREAD_ID,
  providerSessionId: "provider-session-browser-goal",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeHarness = () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make<ReadonlyArray<{ goal: string; confirmed?: boolean }>>([]);
    const service = Layer.succeed(CirceBrowserUse, {
      run: (input) =>
        Ref.update(runs, (existing) => [
          ...existing,
          {
            goal: input.goal,
            ...(input.confirmed === undefined ? {} : { confirmed: input.confirmed }),
          },
        ]).pipe(Effect.as({ status: "done" as const, message: `Did: ${input.goal}`, steps: 1 })),
    });
    const toolkit = yield* PreviewGoalToolkit.pipe(
      Effect.provide(PreviewGoalToolkitHandlersLive.pipe(Layer.provide(service))),
    );
    const call = <Name extends keyof typeof PreviewGoalToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
      capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["preview"],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PreviewGoalToolkit.tools)[Name]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provide(service),
      );
    return { runs, call };
  });

describe("preview goal toolkit handlers", () => {
  it.effect("delegates preview_run_goal to the mission service as a confirmed mission", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("preview_run_goal", { goal: "book a flight" });
      expect(result).toEqual({ status: "done", message: "Did: book a flight", steps: 1 });
      const runs = yield* Ref.get(harness.runs);
      expect(runs.map((run) => run.goal)).toEqual(["book a flight"]);
      expect(runs[0]?.confirmed).toBe(true);
    }),
  );

  it.effect("refuses preview_run_goal without the preview capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.call("preview_run_goal", { goal: "book" }, []).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PreviewAutomationUnavailableError",
        capability: "preview",
      });
    }),
  );
});
