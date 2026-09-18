import type { EnvironmentPresentation, NetworkStatus } from "@circe/client/connection";
import type { EnvironmentCatalogState } from "@circe/client/state/connections";
import type { EnvironmentId } from "@circe/contracts";
import { createEnvironmentSummaryAtoms } from "@circe/client/state/presentation";
import { Atom } from "effect/unstable/reactivity";

import { projectWorkspaceConnectionState } from "./workspaceModel";

export function createWorkspaceConnectionAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly networkStatusValueAtom: Atom.Atom<NetworkStatus>;
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
}) {
  const { environmentsAtom } = createEnvironmentSummaryAtoms(input);
  const isReadyAtom = input.catalogValueAtom.pipe(Atom.map((catalog) => catalog.isReady));
  const stateAtom = Atom.make((get) =>
    projectWorkspaceConnectionState({
      isReady: get(isReadyAtom),
      networkStatus: get(input.networkStatusValueAtom),
      environments: get(environmentsAtom),
    }),
  ).pipe(Atom.withLabel("mobile:workspace-connection-state"));
  return { environmentsAtom, stateAtom, isReadyAtom };
}
