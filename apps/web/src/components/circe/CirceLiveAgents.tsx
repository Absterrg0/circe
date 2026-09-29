import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";

import { useThreadShells } from "../../state/entities";
import { isSidebarSubagentThread } from "../Sidebar.logic";
import { formatRunDuration, overviewTaskState } from "./CirceOverview.logic";
import { ProviderMark } from "./ui/ProviderMark";
import { StatusGlyph, CIRCE_STATUS_WORD } from "./ui/StatusGlyph";

export type CirceActivityFilter = "all" | "running" | "failed";

const ACTIVITY_ROWS = 8;

function clockTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Recent work on every machine, as rows on the canvas. Thread shell events
 * keep it current without polling; a row opens its task on the node that
 * owns it.
 */
export function CirceLiveAgents({
  catalog,
  filter = "all",
}: {
  readonly catalog: CirceMeshCatalog | null;
  readonly filter?: CirceActivityFilter;
}) {
  const threads = useThreadShells();
  const navigate = useNavigate();
  const rows = useMemo(() => {
    const now = new Date();
    const nodes = new Map(catalog?.nodes.map((node) => [node.nodeId, node]));
    return threads
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          !isSidebarSubagentThread(thread),
      )
      .map((thread) => ({ thread, state: overviewTaskState(thread) }))
      .filter(({ state }) =>
        filter === "running"
          ? state === "running" || state === "queued"
          : filter === "failed"
            ? state === "failed"
            : true,
      )
      .toSorted((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt))
      .slice(0, ACTIVITY_ROWS)
      .map(({ thread, state }) => {
        const node = nodes.get(thread.environmentId);
        const project = catalog?.projects.find(
          (candidate) =>
            candidate.ref.nodeId === thread.environmentId &&
            candidate.ref.projectId === thread.projectId,
        );
        const provider = catalog?.providers.find(
          (candidate) =>
            candidate.nodeId === thread.environmentId &&
            candidate.snapshot.instanceId === thread.modelSelection.instanceId,
        );
        const run = thread.latestRun;
        const offline = node !== undefined && node.reachability !== "online";
        return {
          thread,
          state: offline && state !== "failed" ? ("offline" as const) : state,
          projectTitle: project?.title ?? null,
          nodeLabel: node?.label ?? null,
          providerLabel:
            provider?.snapshot.displayName ??
            thread.runtime?.providerName ??
            String(thread.modelSelection.instanceId),
          duration: formatRunDuration(
            run?.startedAt ?? null,
            state === "running" ? null : (run?.completedAt ?? null),
            now,
          ),
          at: clockTime(run?.startedAt ?? thread.updatedAt),
        };
      });
  }, [catalog, filter, threads]);

  if (rows.length === 0) {
    return (
      <p className="ov-empty">
        {filter === "running"
          ? "Nothing is running. Work Circe starts on any machine shows up here."
          : filter === "failed"
            ? "No failed tasks."
            : "Tell Circe what you want done, and the task appears here."}
      </p>
    );
  }

  return (
    <div className="ci-runs" role="list" aria-label="Recent tasks">
      {rows.map((row) => (
        <div
          key={`${row.thread.environmentId}:${row.thread.id}`}
          className={`ci-run ci-run--${row.state}`}
          role="listitem"
          tabIndex={0}
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: row.thread.environmentId, threadId: row.thread.id },
            })
          }
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: row.thread.environmentId, threadId: row.thread.id },
            });
          }}
        >
          <span className="ci-run__glyph">
            <StatusGlyph state={row.state} size={16} label={CIRCE_STATUS_WORD[row.state]} />
          </span>
          <span className="ci-run__task">
            <span className="ci-run__title">{row.thread.title}</span>
            {row.projectTitle ? <span className="ci-run__project">{row.projectTitle}</span> : null}
          </span>
          <span className="ci-run__agent">
            <ProviderMark name={row.providerLabel} />
            <span className="truncate">{row.providerLabel}</span>
          </span>
          <span className="ci-run__node">
            {row.nodeLabel ? `@${row.nodeLabel.toLowerCase()}` : null}
          </span>
          <span className="ci-run__num">
            <span className="ci-run__time">{row.at}</span>
            {row.duration ? <span className="ci-run__dur">{row.duration}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
