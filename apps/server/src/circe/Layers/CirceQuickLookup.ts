import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import * as ServerConfig from "../../config.ts";
import { CirceQuickLookup, runCirceQuickLookup } from "../Services/CirceQuickLookup.ts";

/**
 * Live bounded-tool execution. Resolves the HTTP client once so callers do not
 * need one, and reads the node preset to keep the Full/Controller guard.
 */
export const CirceQuickLookupLive = Layer.effect(
  CirceQuickLookup,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const server = yield* ServerConfig.ServerConfig;
    const preset = server.circeNodePreset ?? "full";
    return CirceQuickLookup.of({
      run: (input) =>
        runCirceQuickLookup(input, preset).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        ),
    });
  }),
);

/** Disabled stub: no tool execution, reports unavailable to the caller. */
export const CirceQuickLookupDisabledLive = Layer.succeed(CirceQuickLookup, {
  run: () =>
    Effect.succeed({
      status: "unavailable" as const,
      message: "Assistant lookups are unavailable on this node.",
    }),
});
