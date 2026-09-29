import type {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListState,
} from "@circe/contracts";
import { isChatWorkspace } from "@circe/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { EyeIcon, FolderGit2Icon, LayersIcon, PenLineIcon } from "lucide-react";
import { useMemo, type ComponentType } from "react";

import { isElectron } from "../../env";
import { useProjects } from "../../state/entities";
import { useEnvironmentConnectionSummaries } from "../../state/environments";
import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarContent } from "../ui/sidebar";
import { PullRequestGlyph } from "./pullRequestIcons";
import {
  pullRequestListPreferences,
  writePullRequestListPreferences,
} from "./pullRequestListPreferences";
import { pullRequestFilterProjects } from "./pullRequestProjectFilter.logic";

interface PullRequestView {
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
}

const VIEWS: ReadonlyArray<PullRequestView> = [
  { label: "Open", icon: PullRequestGlyph.pullRequest, involvement: "all", state: "open" },
  { label: "Needs my review", icon: EyeIcon, involvement: "reviewing", state: "open" },
  { label: "Mine", icon: PenLineIcon, involvement: "authored", state: "open" },
  { label: "Merged", icon: PullRequestGlyph.merged, involvement: "all", state: "merged" },
  { label: "Closed", icon: PullRequestGlyph.closed, involvement: "all", state: "closed" },
];

interface PanelSearch {
  readonly involvement?: PullRequestInvolvement | undefined;
  readonly state?: PullRequestListState | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly environmentId?: EnvironmentId | undefined;
}

/**
 * The pull request page's own sidebar: which pull requests (a view) and
 * from where (a project). Both are the page's URL filters, so the page's
 * filter menu and this panel always agree.
 */
export function PullRequestsPanel() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as PanelSearch;
  const involvement = search.involvement ?? "all";
  const state = search.state ?? "open";
  const allProjects = useProjects();
  const environments = useEnvironmentConnectionSummaries();
  const environmentLabels = useMemo(
    () =>
      new Map(
        environments.map((env) => [env.environmentId as EnvironmentId, env.environmentLabel]),
      ),
    [environments],
  );
  const projects = useMemo(
    () =>
      pullRequestFilterProjects(
        allProjects.filter(
          (project) =>
            !isChatWorkspace(project) && Boolean(project.repositoryIdentity?.canonicalKey),
        ),
        environmentLabels,
      ),
    [allProjects, environmentLabels],
  );

  const scope = (patch: PanelSearch) =>
    void navigate({
      to: "/pull-requests",
      search: (previous: Record<string, unknown>) => {
        const next = { ...previous, ...patch } as Record<string, unknown>;
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        writePullRequestListPreferences(
          pullRequestListPreferences({
            involvement: (next.involvement as PullRequestInvolvement) ?? "all",
            state: (next.state as PullRequestListState) ?? "open",
            ...(next.projectId ? { projectId: next.projectId as ProjectId } : {}),
            ...(next.environmentId ? { environmentId: next.environmentId as EnvironmentId } : {}),
          }),
        );
        return next as never;
      },
    });

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} title="Pull requests" />
      <SidebarContent className="ci-panel">
        <nav className="ci-panel__group" aria-label="Views">
          {VIEWS.map((view) => {
            const Icon = view.icon;
            const active = view.involvement === involvement && view.state === state;
            return (
              <button
                key={view.label}
                type="button"
                className="ci-panel__row"
                aria-current={active ? "true" : undefined}
                data-active={active ? "true" : "false"}
                onClick={() => scope({ involvement: view.involvement, state: view.state })}
              >
                <Icon className="ci-panel__icon" />
                <span className="ci-panel__label">{view.label}</span>
              </button>
            );
          })}
        </nav>
        {projects.length > 0 ? (
          <nav className="ci-panel__group" aria-label="Projects">
            <h2 className="ci-panel__heading">Projects</h2>
            <button
              type="button"
              className="ci-panel__row"
              data-active={search.projectId === undefined ? "true" : "false"}
              onClick={() => scope({ projectId: undefined })}
            >
              <LayersIcon className="ci-panel__icon" />
              <span className="ci-panel__label">All projects</span>
            </button>
            {projects.map((project) => {
              const active =
                search.projectId === project.id &&
                (search.environmentId === undefined ||
                  search.environmentId === project.environmentId);
              return (
                <button
                  key={`${project.environmentId}:${project.id}`}
                  type="button"
                  className="ci-panel__row"
                  data-active={active ? "true" : "false"}
                  onClick={() =>
                    scope({ projectId: project.id, environmentId: project.environmentId })
                  }
                >
                  <FolderGit2Icon className="ci-panel__icon" />
                  <span className="ci-panel__label">{project.title}</span>
                  {environments.length > 1 ? (
                    <span className="ci-panel__meta">
                      {environmentLabels.get(project.environmentId)?.toLowerCase()}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        ) : null}
      </SidebarContent>
    </>
  );
}
