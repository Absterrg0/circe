import { CirceMesh, type CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";
import type { CirceCancelRequestInput } from "@circe/contracts";
import type {
  CirceCancelMissionInput,
  CirceComputerUseInput,
  CirceInteractionId,
  CirceInteractionInterruptInput,
  CirceInteractionSubmitInput,
} from "@circe/contracts";
import { createRuntimeCommand } from "@circe/client/state/runtime";
import type {
  CirceMeshConverseInput,
  CirceMeshExecuteInput,
  CirceMeshInterpretInput,
  CirceMeshManageProjectAliasInput,
  CirceMeshFocusTaskInput,
} from "@circe/client-runtime/circe/mesh";
import type { EnvironmentId } from "@circe/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const catalogStreamAtom = connectionAtomRuntime.atom(
  Stream.unwrap(CirceMesh.pipe(Effect.map((mesh) => mesh.catalogChanges))),
);
export const circeMeshCatalogAtom = Atom.make((get): CirceMeshCatalog | null =>
  Option.getOrNull(AsyncResult.value(get(catalogStreamAtom))),
);

/** All commands and subscriptions share the runtime-owned mesh catalog. */
function runWithMesh<A, E>(operation: (mesh: CirceMesh["Service"]) => Effect.Effect<A, E>) {
  return CirceMesh.pipe(Effect.flatMap((mesh) => operation(mesh)));
}

export const circeMeshEnvironment = {
  refresh: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:refresh",
    execute: () => runWithMesh((mesh) => mesh.refresh),
  }),
  refreshNode: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:refresh-node",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.refreshNode(nodeId)),
  }),
  execute: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:execute",
    execute: (input: CirceMeshExecuteInput) => runWithMesh((mesh) => mesh.execute(input)),
  }),
  interpret: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:interpret",
    execute: (input: CirceMeshInterpretInput) => runWithMesh((mesh) => mesh.interpret(input)),
  }),
  converse: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:converse",
    execute: (input: CirceMeshConverseInput) => runWithMesh((mesh) => mesh.converse(input)),
  }),
  getTaskDesk: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:get-task-desk",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.getTaskDesk(nodeId)),
  }),
  submitInteraction: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:submit-interaction",
    execute: (input: CirceInteractionSubmitInput & { readonly nodeId: EnvironmentId }) => {
      const { nodeId, ...submit } = input;
      return runWithMesh((mesh) => mesh.submitInteraction({ nodeId, input: submit }));
    },
  }),
  readInteraction: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:read-interaction",
    execute: (input: {
      readonly nodeId: EnvironmentId;
      readonly interactionId?: CirceInteractionId | undefined;
    }) => runWithMesh((mesh) => mesh.readInteraction(input)),
  }),
  interruptInteraction: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:interrupt-interaction",
    execute: (input: {
      readonly nodeId: EnvironmentId;
      readonly input: CirceInteractionInterruptInput;
    }) => runWithMesh((mesh) => mesh.interruptInteraction(input)),
  }),
  deviceReadiness: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:device-readiness",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.deviceReadiness(nodeId)),
  }),
  computerStatus: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:computer-status",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.computerStatus(nodeId)),
  }),
  computerUse: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:computer-use",
    execute: (input: { readonly nodeId: EnvironmentId; readonly input: CirceComputerUseInput }) =>
      runWithMesh((mesh) => mesh.computerUse(input)),
  }),
  cancelComputerMission: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:cancel-computer-mission",
    execute: (input: { readonly nodeId: EnvironmentId; readonly input: CirceCancelMissionInput }) =>
      runWithMesh((mesh) => mesh.cancelMission(input)),
  }),
  focusTask: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:focus-task",
    execute: (input: CirceMeshFocusTaskInput) => runWithMesh((mesh) => mesh.focusTask(input)),
  }),
  cancelRequest: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:cancel-request",
    execute: ({
      nodeId,
      input,
    }: {
      readonly nodeId: EnvironmentId;
      readonly input: CirceCancelRequestInput;
    }) => runWithMesh((mesh) => mesh.cancelRequest(nodeId, input)),
  }),
  manageProjectAlias: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:manage-project-alias",
    execute: (input: CirceMeshManageProjectAliasInput) =>
      runWithMesh((mesh) => mesh.manageProjectAlias(input)),
  }),
};
