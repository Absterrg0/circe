// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import {
  registerBrowserConnectorNativeHost,
  type NativeHostRegistrationResult,
} from "./installNativeHost.ts";

/**
 * Boot-time owner of the Chrome native messaging registration. It points
 * Chrome at a launcher for the host script shipped with this desktop build,
 * rewritten on every boot so it follows the app's current executable, and
 * logs what it wrote; a machine without Chrome has no registration to write.
 */
export interface DesktopBrowserConnectorShape {
  readonly register: () => Effect.Effect<NativeHostRegistrationResult>;
}

export class DesktopBrowserConnector extends Context.Service<
  DesktopBrowserConnector,
  DesktopBrowserConnectorShape
>()("@circe/desktop/browserConnector/DesktopBrowserConnector") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment;
  const register = Effect.fn("DesktopBrowserConnector.register")(function* () {
    const hostScriptPath = yield* Effect.sync(() => {
      const candidates = environment.resolveResourcePathCandidates("browser-connector-host.cjs");
      return candidates.find((candidate) => NodeFS.existsSync(candidate)) ?? candidates[0]!;
    });
    const result = yield* Effect.promise(async (): Promise<NativeHostRegistrationResult> => {
      try {
        return await registerBrowserConnectorNativeHost({
          hostScriptPath,
          runtimePath: environment.executablePath,
          homeDir: environment.homeDirectory,
          platform: environment.platform,
          registryManifestDir: environment.stateDir,
        });
      } catch {
        return { written: [], skipped: [] };
      }
    });
    if (result.written.length > 0) {
      yield* Effect.logInfo("Registered the Circe browser connector", {
        manifests: result.written,
      });
    }
    return result;
  });
  // Best-effort boot install: registration is idempotent and a failure only
  // means the user must install the connector later.
  yield* register().pipe(Effect.ignore);
  return DesktopBrowserConnector.of({ register });
});

export const layer = Layer.effect(DesktopBrowserConnector, make);
