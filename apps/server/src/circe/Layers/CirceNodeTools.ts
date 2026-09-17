import type {
  CirceNodeToolExecutor,
  CirceNodeToolExecutors,
  CirceNodeToolRequest,
  CirceToolExecution,
} from "@circe/core/controlDispatch";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import { runCirceQuickLookup } from "../Services/CirceQuickLookup.ts";
import { CirceNodeTools } from "../Services/CirceNodeTools.ts";

/**
 * The production node executors. Weather and time are the only bounded node
 * tools that need no project context; task status and project listing stay
 * ordinary work commands. The HttpClient is captured once at layer build so
 * executors keep the plain `Effect<CirceToolExecution>` seam from core.
 */

const asDay = (value: unknown): "now" | "today" | "tomorrow" =>
  value === "today" || value === "tomorrow" ? value : "now";

const quickLookupExecutor =
  (kind: "weather" | "time", client: HttpClient.HttpClient): CirceNodeToolExecutor =>
  (request: CirceNodeToolRequest): Effect.Effect<CirceToolExecution> =>
    runCirceQuickLookup(
      {
        kind,
        location: String(request.args.location ?? "").trim(),
        day: asDay(request.args.day),
        sourceUtterance: request.source,
      },
      "full",
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.map((result): CirceToolExecution => {
        if (result.status === "answer") return { status: "ok", speech: result.message };
        if (result.status === "needs-input") {
          return { status: "needs-input", prompt: result.message, choices: [] };
        }
        return { status: "failed", speech: result.message };
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.succeed({
              status: "failed" as const,
              speech: "I couldn't reach the lookup service. Try again.",
            }),
      ),
    );

export const CirceNodeToolsLive = Layer.effect(
  CirceNodeTools,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const executors: CirceNodeToolExecutors = {
      weather: quickLookupExecutor("weather", client),
      time: quickLookupExecutor("time", client),
    };
    return CirceNodeTools.of({ available: ["weather", "time"], executors });
  }),
);
