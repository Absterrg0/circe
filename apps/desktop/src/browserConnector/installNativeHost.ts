// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Registers the Circe browser connector as a Chrome native messaging host.
 *
 * The manifest points Chrome at the host script shipped with the desktop app
 * and allows exactly one extension origin. Registration is idempotent and
 * covers Chrome, Chromium, and Edge on Linux and macOS; Windows needs the
 * registry key in addition to the manifest file.
 */

export const BROWSER_CONNECTOR_HOST_NAME = "com.circe.browser_connector";
export const BROWSER_CONNECTOR_EXTENSION_ID = "emjghohcfopghcdlbopgeifkkpfpaphk";

export interface NativeHostRegistrationInput {
  readonly hostScriptPath: string;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  readonly registryManifestDir: string;
}

interface RegistrationTarget {
  readonly manifestPath: string;
  readonly registryKey: string | null;
}

const manifestBody = (hostScriptPath: string) =>
  `${JSON.stringify(
    {
      name: BROWSER_CONNECTOR_HOST_NAME,
      description: "Circe browser connector native messaging host",
      path: hostScriptPath,
      type: "stdio",
      allowed_origins: [`chrome-extension://${BROWSER_CONNECTOR_EXTENSION_ID}/`],
    },
    null,
    2,
  )}\n`;

const posixTargets = (homeDir: string): ReadonlyArray<RegistrationTarget> => [
  {
    manifestPath: NodePath.join(
      homeDir,
      ".config",
      "google-chrome",
      "NativeMessagingHosts",
      `${BROWSER_CONNECTOR_HOST_NAME}.json`,
    ),
    registryKey: null,
  },
  {
    manifestPath: NodePath.join(
      homeDir,
      ".config",
      "chromium",
      "NativeMessagingHosts",
      `${BROWSER_CONNECTOR_HOST_NAME}.json`,
    ),
    registryKey: null,
  },
  {
    manifestPath: NodePath.join(
      homeDir,
      ".config",
      "microsoft-edge",
      "NativeMessagingHosts",
      `${BROWSER_CONNECTOR_HOST_NAME}.json`,
    ),
    registryKey: null,
  },
];

const macTargets = (homeDir: string): ReadonlyArray<RegistrationTarget> =>
  ["Google/Chrome", "Chromium", "Microsoft Edge"].map((browser) => ({
    manifestPath: NodePath.join(
      homeDir,
      "Library",
      "Application Support",
      browser,
      "NativeMessagingHosts",
      `${BROWSER_CONNECTOR_HOST_NAME}.json`,
    ),
    registryKey: null,
  }));

const windowsTargets = (registryManifestDir: string): ReadonlyArray<RegistrationTarget> =>
  ["Google\\Chrome", "Chromium", "Microsoft\\Edge"].map((browser) => ({
    manifestPath: NodePath.join(
      registryManifestDir,
      "native-host",
      `${BROWSER_CONNECTOR_HOST_NAME}.json`,
    ),
    registryKey: `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${BROWSER_CONNECTOR_HOST_NAME}`,
  }));

const targetsFor = (input: NativeHostRegistrationInput): ReadonlyArray<RegistrationTarget> => {
  if (input.platform === "darwin") return macTargets(input.homeDir);
  if (input.platform === "win32") return windowsTargets(input.registryManifestDir);
  return posixTargets(input.homeDir);
};

const writeIfChanged = (path: string, content: string): boolean => {
  try {
    const current = NodeFS.readFileSync(path, "utf8");
    if (current === content) return false;
  } catch {
    // A missing manifest is written below.
  }
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content, { mode: 0o644 });
  return true;
};

const registerWindowsKey = (key: string, manifestPath: string): Promise<void> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "reg.exe",
      ["ADD", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"],
      (error) => {
        if (error) resolve();
        else resolve();
      },
    );
  });

export interface NativeHostRegistrationResult {
  readonly written: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

export async function registerBrowserConnectorNativeHost(
  input: NativeHostRegistrationInput,
): Promise<NativeHostRegistrationResult> {
  if (!NodeFS.existsSync(input.hostScriptPath)) {
    return { written: [], skipped: [] };
  }
  const body = manifestBody(input.hostScriptPath);
  const written: Array<string> = [];
  const skipped: Array<string> = [];
  const seen = new Set<string>();
  for (const target of targetsFor(input)) {
    if (seen.has(target.manifestPath)) continue;
    seen.add(target.manifestPath);
    if (writeIfChanged(target.manifestPath, body)) {
      written.push(target.manifestPath);
    } else {
      skipped.push(target.manifestPath);
    }
    if (target.registryKey !== null) {
      await registerWindowsKey(target.registryKey, target.manifestPath);
    }
  }
  return { written, skipped };
}

/** Default install root for the desktop app's per-user state. */
export const defaultRegistryManifestDir = (homeDir: string): string =>
  NodePath.join(homeDir, ".circe");

export const defaultHomeDir = (): string => NodeOS.homedir();
