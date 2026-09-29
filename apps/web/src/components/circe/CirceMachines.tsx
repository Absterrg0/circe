import { isChatWorkspace, type EnvironmentId } from "@circe/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  FolderGit2Icon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  WifiOffIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CirceComputerSection } from "./CirceComputerSection";
import type { CirceControlCenterDevice } from "./CirceControlCenter.logic";
import { CirceMeshDevices } from "./CirceMeshDevices";
import { CirceNodeAgentSettings } from "./CirceNodeAgentSettings";
import { useCirceMeshCatalog } from "./useCirceMeshCatalog";
import "./circe-pages.css";

function presetLabel(device: CirceControlCenterDevice): string {
  const preset = device.node.capabilities?.preset;
  return preset === undefined ? "Unknown preset" : preset[0]!.toUpperCase() + preset.slice(1);
}

function MachineIcon({ device }: { readonly device: CirceControlCenterDevice }) {
  return device.node.capabilities?.ui === false ? <ServerIcon /> : <MonitorIcon />;
}

/** Every paired machine; picking one shows its details beside the list. */
function MachineList({
  devices,
  selectedNodeId,
  onSelect,
}: {
  readonly devices: ReadonlyArray<CirceControlCenterDevice>;
  readonly selectedNodeId: EnvironmentId | null;
  readonly onSelect: (nodeId: EnvironmentId) => void;
}) {
  return (
    <ul className="circe-machine-list" aria-label="Your machines">
      {devices.map((device) => {
        const online = device.node.reachability === "online";
        return (
          <li key={device.node.nodeId}>
            <button
              type="button"
              className="circe-machine-row"
              aria-pressed={device.node.nodeId === selectedNodeId}
              onClick={() => onSelect(device.node.nodeId)}
            >
              <span className="circe-machine-row__icon">
                <MachineIcon device={device} />
              </span>
              <span className="circe-task-row__text">
                <span className="circe-task-row__title">{device.node.label}</span>
                <span className="circe-task-row__meta">
                  {device.isCurrentDevice ? "This device · " : ""}
                  {presetLabel(device)}
                </span>
              </span>
              <span className="circe-status-dot" data-online={online} aria-hidden />
              <span className="sr-only">{online ? "Online" : "Offline"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MachineHeader({ device }: { readonly device: CirceControlCenterDevice }) {
  const online = device.node.reachability === "online";
  return (
    <header className="circe-machine-header">
      <span className="circe-machine-header__icon">
        <MachineIcon device={device} />
      </span>
      <div className="min-w-0 flex-1">
        <h2>{device.node.label}</h2>
        <p>
          {device.isCurrentDevice ? "This device" : "Paired machine"} · {presetLabel(device)}
        </p>
      </div>
      <span className="circe-pill" data-online={online}>
        <span className="circe-status-dot" data-online={online} aria-hidden />
        {online ? "Online" : "Offline"}
      </span>
      {device.node.catalogError ? (
        <p className="circe-machine-header__error">
          <WifiOffIcon className="size-3.5 shrink-0" />
          {device.node.catalogError}
        </p>
      ) : null}
    </header>
  );
}

function ProviderSection({
  providers,
  onManage,
}: {
  readonly providers: CirceControlCenterDevice["providers"];
  readonly onManage: () => void;
}) {
  return (
    <section className="circe-card" aria-label="Providers">
      <header className="circe-card__header">
        <h2>
          Providers
          {providers.length > 0 ? <span className="circe-count">{providers.length}</span> : null}
        </h2>
        <button type="button" onClick={onManage} className="circe-text-action">
          Manage
        </button>
      </header>
      {providers.length === 0 ? (
        <p className="circe-card__empty">Connect a provider to start working.</p>
      ) : (
        <ul className="circe-plain-list">
          {providers.map((provider) => {
            const state = provider.available
              ? "Ready"
              : !provider.snapshot.enabled
                ? "Off"
                : "Needs setup";
            return (
              <li className="circe-plain-row" key={provider.snapshot.instanceId}>
                <span className="circe-plain-row__icon">
                  <ProviderInstanceIcon
                    driverKind={provider.snapshot.driver}
                    displayName={provider.snapshot.displayName ?? provider.snapshot.driver}
                    iconClassName="size-4"
                  />
                </span>
                <span className="circe-plain-row__name">
                  {provider.snapshot.displayName ?? provider.snapshot.driver}
                </span>
                <span
                  className={cn(
                    "circe-plain-row__state",
                    provider.available && "text-success-foreground",
                  )}
                >
                  {state}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ProjectSection({ projects }: { readonly projects: CirceControlCenterDevice["projects"] }) {
  return (
    <section className="circe-card" aria-label="Projects">
      <header className="circe-card__header">
        <h2>
          Projects
          {projects.length > 0 ? <span className="circe-count">{projects.length}</span> : null}
        </h2>
      </header>
      {projects.length === 0 ? (
        <p className="circe-card__empty">No projects on this machine yet.</p>
      ) : (
        <ul className="circe-plain-list circe-plain-list--scroll">
          {projects.map((project) => (
            <li className="circe-plain-row" key={project.ref.projectId}>
              <span className="circe-plain-row__icon">
                <FolderGit2Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="circe-plain-row__name block">{project.title}</span>
                <Tooltip>
                  <TooltipTrigger render={<span className="circe-plain-row__path" tabIndex={0} />}>
                    {project.workspaceRoot}
                  </TooltipTrigger>
                  <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
                </Tooltip>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Everything about the machines Circe can reach: who is online, what each
 * one can run, and the per-machine settings for Circe's agent and computer
 * use. Pairing and removal stay in Settings → Connections.
 */
export function CirceMachines({
  initialNodeId = null,
}: {
  readonly initialNodeId?: EnvironmentId | null;
}) {
  const navigate = useNavigate();
  const { catalog, view, pending, error, refresh, primaryEnvironmentId } = useCirceMeshCatalog();
  const [selectedNodeId, setSelectedNodeId] = useState<EnvironmentId | null>(
    initialNodeId ?? primaryEnvironmentId,
  );
  const selectedDevice = useMemo(
    () =>
      view.devices.find((device) => device.node.nodeId === selectedNodeId) ??
      view.devices[0] ??
      null,
    [selectedNodeId, view.devices],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="text-sm font-semibold">Machines</h1>
          {view.summary.devices > 0 ? (
            <span className="text-xs text-muted-foreground">
              {view.summary.onlineDevices} of {view.summary.devices} online
            </span>
          ) : null}
          <div className="ms-auto flex items-center gap-2">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Refresh machines"
              disabled={pending}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={cn(pending && "animate-spin motion-reduce:animate-none")} />
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/connections" })}
            >
              <PlusIcon />
              Pair a machine
            </Button>
          </div>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="circe-machines">
            {error ? (
              <p className="circe-alert" role="alert">
                <CircleAlertIcon className="size-4 shrink-0" />
                {error}
              </p>
            ) : null}
            {pending && catalog === null && view.devices.length === 0 ? (
              <p className="circe-card__empty" role="status">
                Finding your machines…
              </p>
            ) : view.devices.length === 0 || selectedDevice === null ? (
              <div className="circe-empty">
                <h2>No machines connected</h2>
                <p>Pair a machine in Connections and it shows up here.</p>
                <Button size="sm" onClick={() => void navigate({ to: "/settings/connections" })}>
                  Open Connections
                </Button>
              </div>
            ) : (
              <div className="circe-machines__layout">
                <aside className="circe-machines__aside">
                  <MachineList
                    devices={view.devices}
                    selectedNodeId={selectedDevice.node.nodeId}
                    onSelect={setSelectedNodeId}
                  />
                  <CirceMeshDevices />
                </aside>
                <div className="circe-machines__detail" key={selectedDevice.node.nodeId}>
                  <MachineHeader device={selectedDevice} />
                  <div className="circe-machines__grid">
                    <ProviderSection
                      providers={selectedDevice.providers}
                      onManage={() =>
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: selectedDevice.node.nodeId },
                        })
                      }
                    />
                    <ProjectSection
                      projects={selectedDevice.projects.filter(
                        (project) => !isChatWorkspace(project),
                      )}
                    />
                  </div>
                  <CirceComputerSection
                    environmentId={selectedDevice.node.nodeId}
                    online={selectedDevice.node.reachability === "online"}
                  />
                  <CirceNodeAgentSettings
                    environmentId={selectedDevice.node.nodeId}
                    online={selectedDevice.node.reachability === "online"}
                    executionEnabled={selectedDevice.node.capabilities?.execution === true}
                  />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
