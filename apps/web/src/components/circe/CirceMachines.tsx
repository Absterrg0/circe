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
import { useMemo, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CirceComputerSection } from "./CirceComputerSection";
import type { CirceControlCenterDevice } from "./CirceControlCenter.logic";
import { CirceNodeAgentSettings } from "./CirceNodeAgentSettings";
import { useCirceMeshCatalog } from "./useCirceMeshCatalog";
import "./circe-pages.css";

function presetLabel(device: CirceControlCenterDevice): string {
  const preset = device.node.capabilities?.preset;
  return preset === undefined ? "Unknown preset" : preset[0]!.toUpperCase() + preset.slice(1);
}

function MachineHeader({ device }: { readonly device: CirceControlCenterDevice }) {
  const online = device.node.reachability === "online";
  return (
    <header className="circe-machine-header">
      <span className="circe-machine-header__icon">
        {device.node.capabilities?.ui === false ? <ServerIcon /> : <MonitorIcon />}
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

/** A headed block of the page, set off by a rule rather than a box. */
function Section({
  title,
  count,
  action,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="circe-section" aria-label={title}>
      <header className="circe-section__header">
        <h2>
          {title}
          {count !== undefined && count > 0 ? <span className="circe-count">{count}</span> : null}
        </h2>
        {action}
      </header>
      {children}
    </section>
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
    <Section
      title="Providers"
      count={providers.length}
      action={
        <button type="button" onClick={onManage} className="circe-text-action">
          Manage
        </button>
      }
    >
      {providers.length === 0 ? (
        <p className="circe-section__empty">Connect a provider to start working.</p>
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
    </Section>
  );
}

function ProjectSection({ projects }: { readonly projects: CirceControlCenterDevice["projects"] }) {
  return (
    <Section title="Projects" count={projects.length}>
      {projects.length === 0 ? (
        <p className="circe-section__empty">No projects on this machine yet.</p>
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
    </Section>
  );
}

/**
 * One machine in full: whether it is online, what it can run, and its
 * settings for Circe's agent and computer use. The Machines list in the
 * context sidebar picks which one; the page follows the `node` search param.
 * Pairing and removal stay in Settings → Connections.
 */
export function CirceMachines({
  initialNodeId = null,
}: {
  readonly initialNodeId?: EnvironmentId | null;
}) {
  const navigate = useNavigate();
  const { catalog, view, pending, error, refresh, primaryEnvironmentId } = useCirceMeshCatalog();
  const selectedNodeId = initialNodeId ?? primaryEnvironmentId;
  const device = useMemo(
    () =>
      view.devices.find((candidate) => candidate.node.nodeId === selectedNodeId) ??
      view.devices[0] ??
      null,
    [selectedNodeId, view.devices],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <WorkspaceBreadcrumb ariaLabel="Machines breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current={device === null}>
              <h1 className="text-sm font-semibold">Machines</h1>
            </WorkspaceBreadcrumbItem>
            {device ? (
              <>
                <WorkspaceBreadcrumbSeparator />
                <WorkspaceBreadcrumbItem current className="min-w-0">
                  <span className="truncate">{device.node.label}</span>
                </WorkspaceBreadcrumbItem>
              </>
            ) : null}
          </WorkspaceBreadcrumb>
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
              <p className="circe-section__empty" role="status">
                Finding your machines…
              </p>
            ) : device === null ? (
              <div className="circe-empty">
                <h2>No machines connected</h2>
                <p>Pair a machine in Connections and it shows up here.</p>
                <Button size="sm" onClick={() => void navigate({ to: "/settings/connections" })}>
                  Open Connections
                </Button>
              </div>
            ) : (
              <div className="circe-machines__detail" key={device.node.nodeId}>
                <MachineHeader device={device} />
                <div className="circe-machines__columns">
                  <ProviderSection
                    providers={device.providers}
                    onManage={() =>
                      void navigate({
                        to: "/settings/providers",
                        search: { environmentId: device.node.nodeId },
                      })
                    }
                  />
                  <ProjectSection
                    projects={device.projects.filter((project) => !isChatWorkspace(project))}
                  />
                </div>
                <CirceComputerSection
                  environmentId={device.node.nodeId}
                  online={device.node.reachability === "online"}
                />
                <CirceNodeAgentSettings
                  environmentId={device.node.nodeId}
                  online={device.node.reachability === "online"}
                  executionEnabled={device.node.capabilities?.execution === true}
                />
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
