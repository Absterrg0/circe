import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { ComputerHostBootstrap } from "@circe/contracts";

import { ComputerHost, type ComputerHostOptions } from "./ComputerHost.ts";

export class DesktopComputerHostStartError extends Schema.TaggedError<DesktopComputerHostStartError>()(
  "DesktopComputerHostStartError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `The desktop computer host could not start: ${this.detail}`;
  }
}

/**
 * The desktop-side computer host as a scoped service. The socket starts on the
 * first request for the bootstrap rather than at layer construction, so an app
 * that never enables computer use pays nothing past the layer's bookkeeping.
 */
export interface DesktopComputerHostShape {
  readonly bootstrap: Effect.Effect<ComputerHostBootstrap, DesktopComputerHostStartError>;
  readonly host: ComputerHost;
}

export class DesktopComputerHost extends Context.Service<
  DesktopComputerHost,
  DesktopComputerHostShape
>()("@circe/desktop/computer/DesktopComputerHost") {}

export const layer = (options: ComputerHostOptions = {}) =>
  Layer.effect(
    DesktopComputerHost,
    Effect.gen(function* () {
      const host = new ComputerHost(options);
      yield* Effect.addFinalizer(() => Effect.promise(() => host.close()));
      const bootstrap = yield* Effect.cached(
        Effect.tryPromise({
          try: () => host.listen(),
          catch: (error) =>
            new DesktopComputerHostStartError({
              detail: error instanceof Error ? error.message : String(error),
            }),
        }),
      );
      return DesktopComputerHost.of({ bootstrap, host });
    }),
  );
