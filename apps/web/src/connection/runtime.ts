import { layer as circeMeshLayer } from "@circe/client-runtime/circe/mesh";
import { Connection } from "@circe/client/connection";
import { shellSnapshotLoaderLayer } from "@circe/client/state/shell";
import {
  boundedThreadSnapshotLoaderLayer,
  threadHistoryControllerLayer,
} from "@circe/client/state/threads";
import { pullRequestDiffLoaderLayer } from "@circe/client/state/pull-requests";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import {
  backgroundActivityObserverLayer,
  backgroundActivityReporterLayer,
} from "../lib/backgroundActivityReporter";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.mergeAll(
  boundedThreadSnapshotLoaderLayer,
  shellSnapshotLoaderLayer,
  threadHistoryControllerLayer,
  pullRequestDiffLoaderLayer,
);

type ConnectionLayerSource =
  | typeof circeMeshLayer
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof backgroundActivityObserverLayer
  | typeof backgroundActivityReporterLayer;

const providedClientConnectionLayer = snapshotLoaderLayer.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({
      environmentThemes: true,
      usageLimitSources: true,
      usageLimitsCommand: true,
    }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      backgroundActivityObserverLayer,
    ),
  ),
);

const connectionLayer = backgroundActivityReporterLayer.pipe(
  Layer.provideMerge(providedClientConnectionLayer),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(circeMeshLayer.pipe(Layer.provideMerge(connectionLayer)));
