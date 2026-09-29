import type { EnvironmentId } from "@circe/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { MonitorIcon, PlusIcon, ServerIcon } from "lucide-react";
import { useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { CirceMeshDevices } from "../circe/CirceMeshDevices";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { SidebarPanelHeader } from "./SidebarChrome";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";
import "../circe/circe-pages.css";

function presetLabel(preset: string | undefined): string | null {
  return preset === undefined ? null : preset[0]!.toUpperCase() + preset.slice(1);
}

/**
 * The context sidebar's Machines list. It reads live connections only, so it
 * costs no catalog fetch; the Machines page loads the selected machine's
 * projects and providers. Account devices reachable through Circe Mesh sit
 * below the list.
 */
export function SidebarMachinesPanel({ isElectron }: { readonly isElectron: boolean }) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { isMobile, setOpenMobile } = useSidebar();
  const location = useLocation({
    select: (current) => ({
      pathname: current.pathname,
      node: (current.search as { readonly node?: string }).node ?? null,
    }),
  });
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
  const selectedId: EnvironmentId | null =
    location.pathname !== "/machines"
      ? null
      : (machines.find((machine) => machine.environmentId === location.node)?.environmentId ??
        primaryEnvironmentId ??
        machines[0]?.environmentId ??
        null);

  return (
    <>
      <SidebarPanelHeader
        isElectron={isElectron}
        title="Machines"
        actions={
          <SidebarHeaderIconButton
            label="Pair a machine"
            render={<Link to="/settings/connections" />}
          >
            <PlusIcon />
          </SidebarHeaderIconButton>
        }
      />
      <SidebarContent>
        <SidebarGroup className="gap-4 p-[var(--sidebar-content-inset)]">
          {machines.length === 0 ? (
            <p className="circe-panel-empty">
              No machines yet. Pair one from <strong>Settings → Connections</strong>.
            </p>
          ) : (
            <ul className="flex flex-col gap-px" aria-label="Machines">
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
                      className="circe-panel-row"
                      data-active={machine.environmentId === selectedId ? "true" : "false"}
                      data-offline={online ? "false" : "true"}
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
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
        </SidebarGroup>
      </SidebarContent>
    </>
  );
}
