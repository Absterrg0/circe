import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runCirceNodeTool, type CirceNodeToolExecutors } from "./controlDispatch.ts";

const executors: CirceNodeToolExecutors = {
  weather: (request) =>
    Effect.succeed({ status: "ok", speech: `Weather for ${String(request.args.location)}.` }),
};

describe("node tool dispatch", () => {
  it.effect("runs the executor registered for a node tool", () =>
    Effect.gen(function* () {
      const result = yield* runCirceNodeTool({
        request: { toolName: "weather", args: { location: "Paris" }, source: "weather in Paris" },
        executors,
      });
      expect(result).toEqual({ status: "ok", speech: "Weather for Paris." });
    }),
  );

  it.effect("refuses a client tool at the node dispatcher", () =>
    Effect.gen(function* () {
      const result = yield* runCirceNodeTool({
        request: { toolName: "open-website", args: {}, source: "open youtube" },
        executors,
      });
      expect(result.status).toBe("failed");
    }),
  );

  it.effect("reports a missing executor as a wiring failure, never a user refusal", () =>
    Effect.gen(function* () {
      const result = yield* runCirceNodeTool({
        request: { toolName: "time", args: {}, source: "what time is it" },
        executors,
      });
      expect(result).toEqual({
        status: "failed",
        speech: "The time tool has no executor on this node.",
      });
    }),
  );
});
