import { MonitorIcon, ServerIcon, SmartphoneIcon, LaptopIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Presence, type CircePresenceState } from "./StatusGlyph";

import "./circe-ui.css";

const PROVIDER_MONOGRAMS: Readonly<Record<string, string>> = {
  codex: "Cx",
  claude: "Cl",
  claudeagent: "Cl",
  cursor: "Cu",
  grok: "Gk",
  opencode: "Oc",
  antigravity: "Ag",
  gemini: "Gm",
};

/** Two-letter monogram for a provider driver or display name ("Codex" -> "Cx"). */
export function providerMonogram(nameOrKind: string): string {
  const key = nameOrKind.replace(/[^a-z]/gi, "").toLowerCase();
  const known = PROVIDER_MONOGRAMS[key];
  if (known) return known;
  const letters = nameOrKind.replace(/[^a-z]/gi, "");
  if (letters.length === 0) return "?";
  return letters.charAt(0).toUpperCase() + (letters.charAt(1) ?? "").toLowerCase();
}

/**
 * Providers appear as monogram tiles in UI chrome; provider logos belong in
 * provider settings only.
 */
export function ProviderMark({
  name,
  size = 16,
  className,
}: {
  readonly name: string;
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("ci-providermark", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}
    >
      {providerMonogram(name)}
    </span>
  );
}

export type CirceDeviceKind = "laptop" | "desktop" | "server" | "phone";

export function DeviceIcon({
  device,
  className,
}: {
  readonly device: CirceDeviceKind;
  readonly className?: string;
}) {
  const Icon =
    device === "laptop"
      ? LaptopIcon
      : device === "phone"
        ? SmartphoneIcon
        : device === "server"
          ? ServerIcon
          : MonitorIcon;
  return <Icon aria-hidden className={className} strokeWidth={1.5} />;
}

/** Every task names its machine: a node's lowercase name with its presence. */
export function NodeChip({
  name,
  device = "desktop",
  presence,
  route,
  size = "md",
  bare = false,
  className,
}: {
  readonly name: string;
  readonly device?: CirceDeviceKind;
  readonly presence?: CircePresenceState;
  readonly route?: string | null;
  readonly size?: "sm" | "md";
  readonly bare?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "ci-node",
        size === "sm" && "ci-node--sm",
        bare && "ci-node--bare",
        presence === "offline" && "ci-node--offline",
        className,
      )}
    >
      <span className="ci-node__tile">
        <DeviceIcon device={device} className={size === "sm" ? "size-3" : "size-3.5"} />
        {presence ? <Presence state={presence} ring="var(--raised)" /> : null}
      </span>
      <span className="ci-node__name">{name}</span>
      {route ? <span className="ci-node__route">{route}</span> : null}
    </span>
  );
}
