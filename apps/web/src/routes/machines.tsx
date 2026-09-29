import { EnvironmentId } from "@circe/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { CirceMachines } from "../components/circe/CirceMachines";

function MachinesRoute() {
  const { node } = Route.useSearch();
  // Keyed so a link to another machine reselects it even while mounted.
  return <CirceMachines key={node ?? ""} initialNodeId={node ? EnvironmentId.make(node) : null} />;
}

export const Route = createFileRoute("/machines")({
  validateSearch: (raw: Record<string, unknown>): { node?: string } =>
    typeof raw.node === "string" && raw.node.length > 0 ? { node: raw.node } : {},
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: MachinesRoute,
});
