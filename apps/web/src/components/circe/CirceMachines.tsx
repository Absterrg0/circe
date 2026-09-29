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
import { useMemo } from "react";

import { isElectron } from "../../env";
import { useThreadShells } from "../../state/entities";
import { filterSidebarV2VisibleThreads, resolveSidebarThreadStatus } from "../Sidebar.logic";
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
import { CirceCardHeader, CirceCardLinkLabel } from "./CirceCard";
import { CirceComputerSection } from "./CirceComputerSection";
import type { CirceControlCenterDevice } from "./CirceControlCenter.logic";
import { CirceNodeAgentSettings } from "./CirceNodeAgentSettings";
import type { CirceTone } from "./CirceStatusGlyph";
import { useCirceMeshCatalog } from "./useCirceMeshCatalog";
import "./circe-pages.css";

function presetLabel(device: CirceControlCenterDevice): string {
  const preset = device.node.capabilities?.preset;
  return preset === undefined ? "Unknown preset" : preset[0]!.toUpperCase() + preset.slice(1);
}

function MachineHeader({
  device,
  running,
}: {
  readonly device: CirceControlCenterDevice;
  readonly running: number;
}) {
  const online = device.node.reachability === "online";
  const readyProviders = device.providers.filter((provider) => provider.available).length;
  const projects = device.projects.filter((project) => !isChatWorkspace(project)).length;
  return (
    <header className="circe-card circe-machine-header">
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
      <dl className="circe-machine-header__stats">
        <div>
          <dt>Running</dt>
          <dd>{running}</dd>
        </div>
        <div>
          <dt>Agents ready</dt>
          <dd>
            {readyProviders}
            <span className="text-muted-foreground"> / {device.providers.length}</span>
          </dd>
        </div>
        <div>
          <dt>Projects</dt>
          <dd>{projects}</dd>
        </div>
      </dl>
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
    <section className="circe-card" aria-label="Agents">
      <CirceCardHeader
        title="Agents"
        count={providers.length}
        link={
          <button type="button" onClick={onManage} className="circe-card__link">
            <CirceCardLinkLabel>Manage</CirceCardLinkLabel>
          </button>
        }
      />
      {providers.length === 0 ? (
        <p className="circe-card__empty">Connect a coding agent to start working.</p>
      ) : (
        <ul className="circe-rows">
          {providers.map((provider) => {
            const tone: CirceTone = provider.available
              ? "done"
              : !provider.snapshot.enabled
                ? "idle"
                : "attention";
            return (
              <li key={provider.snapshot.instanceId}>
                <div className="circe-row">
                  <span className="circe-row__icon">
                    <ProviderInstanceIcon
                      driverKind={provider.snapshot.driver}
                      displayName={provider.snapshot.displayName ?? provider.snapshot.driver}
                      iconClassName="size-4"
                    />
                  </span>
                  <span className="circe-row__text">
                    <span className="circe-row__title">
                      {provider.snapshot.displayName ?? provider.snapshot.driver}
                    </span>
                  </span>
                  <span className="circe-state" data-tone={tone}>
                    <span className="circe-status-dot" aria-hidden />
                    {provider.available
                      ? "Ready"
                      : !provider.snapshot.enabled
                        ? "Off"
                        : "Needs setup"}
                  </span>
                </div>
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
      <CirceCardHeader title="Projects" count={projects.length} />
      {projects.length === 0 ? (
        <p className="circe-card__empty">No projects on this machine yet.</p>
      ) : (
        <ul className="circe-rows circe-rows--scroll">
          {projects.map((project) => (
            <li key={project.ref.projectId}>
              <div className="circe-row">
                <span className="circe-row__icon">
                  <FolderGit2Icon />
                </span>
                <span className="circe-row__text">
                  <span className="circe-row__title">{project.title}</span>
                  <Tooltip>
                    <TooltipTrigger render={<span className="circe-row__meta" tabIndex={0} />}>
                      <span>{project.workspaceRoot}</span>
                    </TooltipTrigger>
                    <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
                  </Tooltip>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
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
  const threads = useThreadShells();
  const runningByNode = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of filterSidebarV2VisibleThreads(threads, null)) {
      if (resolveSidebarThreadStatus(thread) !== "working") continue;
      counts.set(thread.environmentId, (counts.get(thread.environmentId) ?? 0) + 1);
    }
    return counts;
  }, [threads]);
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
                <MachineHeader
                  device={device}
                  running={runningByNode.get(device.node.nodeId) ?? 0}
                />
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
