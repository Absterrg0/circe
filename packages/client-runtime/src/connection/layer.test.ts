import { EnvironmentId } from "@circe/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@circe/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { watchDiscoveredCompatibility } from "./layer.ts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type NetworkStatus as ConnectionNetworkStatus,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";

// A relay deployed before orchestration protocol negotiation strips the
// optional version key while the node itself still reports it. This is the
// status shape that reaches the client through discovery.
const relayEnvironment: RelayClientEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-primary"),
  label: "fedora",
  endpoint: {
    httpBaseUrl: "https://fedora.example.test",
    wsBaseUrl: "wss://fedora.example.test",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-09-19T00:00:00.000Z",
  enabled: true,
};

const statusWithoutProtocol: RelayEnvironmentStatusResponse = {
  environmentId: relayEnvironment.environmentId,
  endpoint: relayEnvironment.endpoint,
  status: "online",
  checkedAt: "2026-09-19T12:00:00.000Z",
  descriptor: {
    environmentId: relayEnvironment.environmentId,
    label: "fedora",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.52",
    capabilities: { repositoryIdentity: true },
  },
};

const primaryEntry = (): ConnectionCatalogEntry => ({
  target: new PrimaryConnectionTarget({
    environmentId: relayEnvironment.environmentId,
    label: "fedora",
    httpBaseUrl: "http://127.0.0.1:3773/",
    wsBaseUrl: "ws://127.0.0.1:3773/",
  }),
  profile: Option.none(),
  enabled: true,
});

const relayEntry = (): ConnectionCatalogEntry => ({
  target: new RelayConnectionTarget({
    environmentId: relayEnvironment.environmentId,
    label: "fedora",
  }),
  profile: Option.none(),
  enabled: true,
});

const runWatcher = (entry: ConnectionCatalogEntry) =>
  Effect.gen(function* () {
    const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([[entry.target.environmentId, entry]]),
    );
    const state =
      yield* SubscriptionRef.make<RelayEnvironmentDiscovery.RelayEnvironmentDiscoveryState>({
        environments: new Map(),
        refreshing: false,
        offline: false,
        error: Option.none(),
      });
    const calls = yield* Ref.make<
      ReadonlyArray<{ readonly environmentId: string; readonly reason: string | null }>
    >([]);
    const networkStatus = yield* SubscriptionRef.make<ConnectionNetworkStatus>("online");
    const registry = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
      entries,
      networkStatus,
      setCompatibility: (environmentId, error) =>
        Ref.update(calls, (current) => [
          ...current,
          { environmentId, reason: error?.reason ?? null },
        ]),
    });
    const discovery = Layer.mock(RelayEnvironmentDiscovery.RelayEnvironmentDiscovery)({
      state,
      refresh: Effect.void,
    });
    yield* watchDiscoveredCompatibility().pipe(
      Effect.provide(Layer.mergeAll(registry, discovery)),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    yield* SubscriptionRef.set(state, {
      environments: new Map<string, RelayEnvironmentDiscovery.RelayDiscoveredEnvironment>([
        [
          relayEnvironment.environmentId,
          {
            environment: relayEnvironment,
            availability: "online",
            status: Option.some(statusWithoutProtocol),
            error: Option.none(),
          },
        ],
      ]),
      refreshing: false,
      offline: false,
      error: Option.none(),
    });
    for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow;
    return yield* Ref.get(calls);
  }).pipe(Effect.scoped);

describe("discovered environment compatibility", () => {
  it.effect("never disables a directly reachable environment from a stale relay descriptor", () =>
    Effect.gen(function* () {
      const calls = yield* runWatcher(primaryEntry());
      expect(calls).toEqual([]);
    }),
  );

  it.effect("still applies discovery compatibility to relay-routed environments", () =>
    Effect.gen(function* () {
      const calls = yield* runWatcher(relayEntry());
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls.map((call) => call.reason))).toEqual(new Set(["unsupported"]));
      expect(calls[0]?.environmentId).toBe(relayEnvironment.environmentId);
    }),
  );
});
