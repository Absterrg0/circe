import { squashAtomCommandFailure } from "@circe/client/state/runtime";
import type { CirceMeshCatalog, CirceMeshNode } from "@circe/client-runtime/circe/mesh";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { circeMeshEnvironment } from "../../state/circeMesh";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildCirceControlCenterView } from "./CirceControlCenter.logic";
import { circeErrorMessage } from "./CirceManager.logic";

const EMPTY_CATALOG: CirceMeshCatalog = { nodes: [], projects: [], providers: [] };

/**
 * Every paired machine with its projects and providers, for Home and the
 * Machines page. Connections are live and drive reachability; the project and
 * provider catalog loads asynchronously and refetches whenever a connection
 * changes phase. A reply that lands after a newer refresh started is dropped
 * so a stale catalog never shows projects on the wrong machine.
 */
export function useCirceMeshCatalog() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const refreshMesh = useAtomCommand(circeMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const [catalog, setCatalog] = useState<CirceMeshCatalog | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);
  const connectionKey = JSON.stringify(
    environments.map((environment) => [environment.environmentId, environment.connection.phase]),
  );
  const registeredNodes = useMemo(
    () =>
      environments.map((environment): CirceMeshNode => ({
        nodeId: environment.environmentId,
        label: environment.serverConfig?.environment.label ?? environment.label,
        reachability: environment.connection.phase === "connected" ? "online" : "offline",
        ...(environment.serverConfig?.environment.capabilities.circeNode === undefined
          ? {}
          : { capabilities: environment.serverConfig.environment.capabilities.circeNode }),
        ...(environment.connection.error === null
          ? {}
          : { catalogError: environment.connection.error }),
      })),
    [environments],
  );
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    setPending(true);
    setError(null);
    const result = await refreshMesh(undefined);
    if (generation !== refreshGeneration.current) return;
    if (result._tag === "Failure") {
      setError(circeErrorMessage(squashAtomCommandFailure(result)));
    } else {
      setCatalog(result.value);
    }
    setPending(false);
  }, [refreshMesh]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh, connectionKey]);

  const view = useMemo(
    () =>
      buildCirceControlCenterView(catalog ?? EMPTY_CATALOG, {
        registeredNodes,
        currentNodeId: isElectron ? primaryEnvironmentId : null,
      }),
    [catalog, registeredNodes, primaryEnvironmentId],
  );
  // The command console resolves targets against live reachability, not the
  // catalog's snapshot of it.
  const liveCatalog = useMemo(
    () => (catalog === null ? null : { ...catalog, nodes: registeredNodes }),
    [catalog, registeredNodes],
  );

  return { catalog: liveCatalog, view, pending, error, refresh, primaryEnvironmentId };
}
