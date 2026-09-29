import { EnvironmentId } from "@circe/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const CirceControlCenter = lazy(async () => {
  const module = await import("../components/circe/CirceControlCenter");
  return { default: module.CirceControlCenter };
});

function CirceControlCenterRoute() {
  const { machine } = Route.useSearch();
  return (
    <Suspense fallback={null}>
      <CirceControlCenter {...(machine === undefined ? {} : { machine })} />
    </Suspense>
  );
}

export const Route = createFileRoute("/circe")({
  // `machine` opens that machine's details, which is where the rail's
  // machine tiles lead.
  validateSearch: (raw: Record<string, unknown>): { readonly machine?: EnvironmentId } =>
    typeof raw.machine === "string" && raw.machine.trim()
      ? { machine: EnvironmentId.make(raw.machine) }
      : {},
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: CirceControlCenterRoute,
});
