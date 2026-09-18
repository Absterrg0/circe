import type { CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";

/**
 * The one no-device message.
 *
 * A device is a connected Circe node. Without one the app cannot resolve a
 * project, run a lookup, delegate to a provider, or start work, so every entry
 * point answers with this before attempting a node RPC. Reporting the transport
 * error that follows a doomed attempt is what made the empty state look like a
 * bug instead of a setup step.
 */
export const NO_DEVICES_COPY =
  "No devices are connected. Connect a device in Settings, then try again.";

/**
 * True when at least one node in the catalog is reachable. A catalog that has
 * not loaded yet is not "connected" either, so the caller can gate uniformly.
 */
export function hasOnlineCirceNode(catalog: CirceMeshCatalog | null | undefined): boolean {
  return (catalog?.nodes ?? []).some((node) => node.reachability === "online");
}
