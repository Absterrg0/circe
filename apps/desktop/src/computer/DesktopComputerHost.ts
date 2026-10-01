import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { ComputerHostBootstrap } from "@circe/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { ComputerHost, type ComputerHostOptions } from "./ComputerHost.ts";
import { CuaRuntime } from "./CuaRuntime.ts";

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

/** Where the archive a bundled catalog names is published. */
const Distribution = Schema.Struct({
  archiveUrl: Schema.String.check(Schema.isStartsWith("https://")),
});

/** Rust target triples that the perception extension is published for. */
const perceptionTarget = (platform: NodeJS.Platform, arch: string): string | undefined => {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "win32" && arch === "arm64") return "aarch64-pc-windows-msvc";
  return undefined;
};

export const layer = (options: ComputerHostOptions = {}) =>
  Layer.effect(
    DesktopComputerHost,
    Effect.gen(function* () {
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The signed catalog and its archive ship as app resources for the
      // node's own target; the driver verifies and installs them itself.
      const target = perceptionTarget(environment.platform, environment.processArch);
      let bundledCatalog: string | undefined;
      for (const candidate of target === undefined
        ? []
        : environment.resolveResourcePathCandidates(
            path.join("cua-perception", target, "signed-catalog.json"),
          )) {
        if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
          bundledCatalog = candidate;
          break;
        }
      }
      const cuaHome = path.join(environment.baseDir, "cua-driver");
      const stagingDirectory = path.join(cuaHome, "perception-staging");
      const distribution =
        bundledCatalog === undefined
          ? undefined
          : yield* fileSystem
              .readFileString(path.join(path.dirname(bundledCatalog), "distribution.json"))
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Distribution))),
                Effect.option,
              );
      const perception =
        bundledCatalog !== undefined && distribution !== undefined && distribution._tag === "Some"
          ? { bundledCatalog, archiveUrl: distribution.value.archiveUrl, stagingDirectory }
          : undefined;
      const context = yield* Effect.context<never>();
      const log = (message: string, fields: Record<string, unknown>) =>
        Effect.runForkWith(context)(Effect.logInfo(message, fields));
      const host = new ComputerHost({
        runtime: new CuaRuntime({
          home: cuaHome,
          ...(perception === undefined
            ? {}
            : { perceptionCatalog: path.join(stagingDirectory, "signed-catalog.json") }),
        }),
        log,
        ...(perception === undefined ? {} : { perception }),
        ...options,
      });
      yield* Effect.logDebug("desktop computer host configured", {
        perceptionTarget: target,
        perceptionCatalog: bundledCatalog ?? null,
      });
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
