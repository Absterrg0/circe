// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import {
  CirceBrowserConnector,
  CirceBrowserConnectorError,
} from "../Services/CirceBrowserConnector.ts";
import { makeConnectorServer } from "../browserConnector/ConnectorServer.ts";

const toConnectorError = (cause: unknown): CirceBrowserConnectorError =>
  new CirceBrowserConnectorError({
    message: cause instanceof Error ? cause.message : "The browser connector is unavailable.",
  });

/**
 * Owns the node-local connector listener and its token file. A connector that
 * disconnects fails every pending request instead of leaving a caller waiting,
 * and the socket is removed on shutdown.
 */
export const CirceBrowserConnectorLive = Layer.effect(
  CirceBrowserConnector,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const server = makeConnectorServer({
      socketPath: NodePath.join(config.stateDir, "browser-connector.sock"),
      tokenPath: NodePath.join(config.stateDir, "browser-connector.token"),
    });
    // A node without the connector socket is still a working node: readiness
    // reports the failure and browser missions say so, rather than the whole
    // server failing to start.
    const listener = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => server.start(),
        catch: toConnectorError,
      }).pipe(
        Effect.map(() => ({ listening: true as const })),
        Effect.catch((error) =>
          Effect.logWarning("Browser connector listener unavailable", {
            message: error.message,
          }).pipe(Effect.as({ listening: false as const, detail: error.message })),
        ),
      ),
      () => Effect.promise(() => server.stop()).pipe(Effect.orDie),
    );

    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: toConnectorError });

    return CirceBrowserConnector.of({
      status: (profileLabel) =>
        Effect.sync(() => {
          const current = server.status(profileLabel);
          return listener.listening
            ? current
            : { ...current, ...("detail" in listener ? { detail: listener.detail } : {}) };
        }),
      listTabs: (profileLabel) => attempt(() => server.listTabs(profileLabel)),
      attach: (input) =>
        attempt(() =>
          server.attach({
            tabId: input.tabId,
            ...(input.profileLabel === undefined ? {} : { profileLabel: input.profileLabel }),
          }),
        ),
      snapshot: (profileLabel) => attempt(() => server.snapshot(profileLabel)),
      apply: (action, profileLabel) => attempt(() => server.apply(action, profileLabel)),
    });
  }),
);
