import type { EnvironmentId } from "@circe/contracts";
import { Link } from "@tanstack/react-router";
import { MonitorIcon, ServerIcon } from "lucide-react";
import { useMemo } from "react";

import { isElectron } from "../../env";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { CirceMeshDevices } from "./CirceMeshDevices";
import "./circe-pages.css";

function presetLabel(preset: string | undefined): string | null {
  return preset === undefined ? null : preset[0]!.toUpperCase() + preset.slice(1);
}

/**
 * The Machines page's list of paired nodes, with this device first on the
 * desktop. It reads live connections only, so it costs no catalog fetch; the
 * page loads the selected machine's projects and providers. Account devices
 * reachable through Circe Mesh sit below the list.
 */
export function CirceMachineList({ selectedId }: { readonly selectedId: EnvironmentId | null }) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Desktop is this device; a browser's primary environment is a remote node.
  const currentDeviceId = isElectron ? primaryEnvironmentId : null;
  const machines = useMemo(
    () =>
      environments.toSorted(
        (left, right) =>
          Number(right.environmentId === currentDeviceId) -
          Number(left.environmentId === currentDeviceId),
      ),
    [currentDeviceId, environments],
  );

  return (
    <aside className="circe-machines__list" aria-label="Machines">
      {machines.length === 0 ? (
        <p className="circe-panel-empty">
          No machines yet. Pair one from <strong>Settings → Connections</strong>.
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {machines.map((machine) => {
            const online = machine.connection.phase === "connected";
            const node = machine.serverConfig?.environment.capabilities.circeNode;
            const label = machine.serverConfig?.environment.label ?? machine.label;
            const meta = [
              machine.environmentId === currentDeviceId ? "This device" : null,
              presetLabel(node?.preset),
              online ? null : "Offline",
            ].filter((part) => part !== null);
            return (
              <li key={machine.environmentId} className="list-none">
                <Link
                  to="/machines"
                  search={{ node: machine.environmentId }}
                  replace
                  className="circe-panel-row"
                  data-active={machine.environmentId === selectedId ? "true" : "false"}
                  data-offline={online ? "false" : "true"}
                >
                  <span className="circe-panel-row__icon">
                    {node?.ui === false ? <ServerIcon /> : <MonitorIcon />}
                  </span>
                  <span className="circe-panel-row__text">
                    <span className="circe-panel-row__name">{label}</span>
                    <span className="circe-panel-row__meta">
                      {meta.length > 0 ? meta.join(" · ") : "Online"}
                    </span>
                  </span>
                  <span className="circe-status-dot" data-online={online} aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <CirceMeshDevices />
    </aside>
  );
}
