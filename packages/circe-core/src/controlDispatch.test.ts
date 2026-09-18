import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { runCirceNodeTool, type CirceNodeToolExecutors } from "./controlDispatch.ts";

const executors: CirceNodeToolExecutors = {
  weather: (request) =>
    Effect.succeed({ status: "ok", speech: `Weather for ${String(request.args.location)}.` }),
};

describe("node tool dispatch", () => {
  it("runs the executor registered for a node tool", () => {
    const result = Effect.runSync(
      runCirceNodeTool({
        request: { toolName: "weather", args: { location: "Paris" }, source: "weather in Paris" },
        executors,
      }),
    );
    expect(result).toEqual({ status: "ok", speech: "Weather for Paris." });
  });

  it("refuses a client tool at the node dispatcher", () => {
    const result = Effect.runSync(
      runCirceNodeTool({
        request: { toolName: "open-website", args: {}, source: "open youtube" },
        executors,
      }),
    );
    expect(result.status).toBe("failed");
  });

  it("reports a missing executor as a wiring failure, never a user refusal", () => {
    const result = Effect.runSync(
      runCirceNodeTool({
        request: { toolName: "time", args: {}, source: "what time is it" },
        executors,
      }),
    );
    expect(result).toEqual({
      status: "failed",
      speech: "The time tool has no executor on this node.",
    });
  });
});
