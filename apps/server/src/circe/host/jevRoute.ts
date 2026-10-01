import type { DecisionRequest } from "@circe/core/decision";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { CirceDecision } from "../Services/CirceDecision.ts";
import type { CirceCore, Jev, JevRequest, JevResponse } from "./core.ts";

/**
 * How this node reaches Jev for circe-core, shared by Circe's interpreter and
 * its desktop executor. Both wait on these calls, so the user's own TypeSafe
 * key (TYPESAFE_API_KEY or ~/.config/circe/typesafe-key) is used directly
 * when there is one: the relay adds about a second per call. Without one,
 * the node's own route (`CirceDecision`): its configured key, or the linked
 * relay.
 */
export const makeJevRoute = (decision: CirceDecision["Service"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const context = yield* Effect.context<never>();
    const run = <A>(effect: Effect.Effect<A>) => Effect.runPromiseWith(context)(effect);
    const home = yield* Config.string("HOME").pipe(
      Config.withDefault(""),
      Effect.orElseSucceed(() => ""),
    );
    const ownKey =
      (yield* Config.string("TYPESAFE_API_KEY").pipe(
        Config.withDefault(""),
        Effect.orElseSucceed(() => ""),
      )).length > 0 ||
      (home.length > 0 &&
        (yield* fs
          .exists(path.join(home, ".config", "circe", "typesafe-key"))
          .pipe(Effect.orElseSucceed(() => false))));

    return (core: CirceCore): Jev => {
      const direct = core.httpJev();
      return {
        async ask(request) {
          if (ownKey) return direct.ask(request);
          const started = performance.now();
          const outcome = await run(decision.decide(request as unknown as DecisionRequest));
          if (outcome.status === "answered") {
            return checked(request, {
              model: outcome.model,
              answers: outcome.answers as JevResponse["answers"],
              usage: { input_tokens: 0, output_tokens: 0 },
              latencyMs: performance.now() - started,
              cached: false,
            });
          }
          if (outcome.reason === "decision-timeout")
            throw new core.JevTimeoutError("TypeSafe did not answer in time");
          throw new Error(`TypeSafe declined: ${outcome.reason}`);
        },
      };
    };
  });

/** A response that answers every question asked, with the type asked; anything else is a failed call. */
function checked(request: JevRequest, response: JevResponse): JevResponse {
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = response.answers[id];
    if (answer === undefined) throw new Error(`TypeSafe omitted answer ${id}`);
    if (answer.type !== question.type)
      throw new Error(`TypeSafe answered ${id} with ${answer.type}, expected ${question.type}`);
  }
  return response;
}
