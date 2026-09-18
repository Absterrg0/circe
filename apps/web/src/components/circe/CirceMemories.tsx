import { ProjectId, type CirceMemoryIndex, type EnvironmentId } from "@circe/contracts";
import { squashAtomCommandFailure } from "@circe/client/state/runtime";
import { ChevronDownIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { circeEnvironment } from "../../state/circe";
import { Button } from "../ui/button";
import { circeErrorMessage } from "./CirceManager.logic";
import type { CirceControlCenterDevice } from "./CirceControlCenter.logic";

/**
 * The memory escape hatch. Circe maintains memory on its own; this panel only
 * lists what a project remembers and lets the user forget an entry, which
 * retires it to `retired/` so provenance survives. It is scoped to the primary
 * environment because memory is node-local.
 */
export function CirceMemories({
  projects,
  environmentId,
  enabled,
}: {
  readonly projects: CirceControlCenterDevice["projects"];
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
}) {
  const memoryIndex = useAtomCommand(circeEnvironment.memoryIndex, {
    reportFailure: false,
    reportDefect: false,
  });
  const forgetMemory = useAtomCommand(circeEnvironment.forgetMemory, {
    reportFailure: false,
    reportDefect: false,
  });
  const [projectId, setProjectId] = useState<string>(projects[0]?.ref.projectId ?? "");
  const [index, setIndex] = useState<CirceMemoryIndex | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (id: string) => {
      if (id.length === 0) return;
      setPending(true);
      setError(null);
      const result = await memoryIndex({
        environmentId,
        input: { projectId: ProjectId.make(id) },
      });
      if (result._tag === "Failure") {
        setError(circeErrorMessage(squashAtomCommandFailure(result)));
        setIndex(null);
      } else {
        setIndex(result.value);
      }
      setPending(false);
    },
    [environmentId, memoryIndex],
  );

  useEffect(() => {
    if (enabled) void load(projectId);
  }, [enabled, load, projectId]);

  if (!enabled || projects.length === 0) return null;

  const forget = async (entryId: string) => {
    const result = await forgetMemory({
      environmentId,
      input: { projectId: ProjectId.make(projectId), entryId },
    });
    if (result._tag === "Failure") {
      setError(circeErrorMessage(squashAtomCommandFailure(result)));
      return;
    }
    await load(projectId);
  };

  return (
    <details className="circe-project-section">
      <summary className="circe-section-heading">
        <span>
          Memories
          <span className="circe-inline-count">{index?.entries.length ?? 0}</span>
        </span>
        <ChevronDownIcon className="size-4" />
      </summary>
      <label className="circe-muted-note flex items-center gap-2">
        Project
        <select
          className="rounded border border-border bg-background px-1.5 py-1 text-xs"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.ref.projectId} value={project.ref.projectId}>
              {project.title}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="circe-muted-note text-destructive-foreground">{error}</p> : null}
      {pending ? (
        <p className="circe-muted-note">Loading memory…</p>
      ) : index === null || index.entries.length === 0 ? (
        <p className="circe-muted-note">Nothing remembered yet.</p>
      ) : (
        <div className="circe-project-list">
          {index.entries.map((entry) => (
            <div className="circe-project-row" key={entry.id}>
              <div className="min-w-0 flex-1">
                <p title={entry.title}>{entry.title}</p>
                <span className="circe-muted-note">
                  {entry.kind} · from {entry.source} · {entry.tokens} tokens
                </span>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Forget memory ${entry.title}`}
                onClick={() => void forget(entry.id)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}
