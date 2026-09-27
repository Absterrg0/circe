// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * Registers the Circe browser connector as a Chrome native messaging host.
 *
 * Chrome executes the manifest's path directly, and the host script shipped
 * with the desktop app is JavaScript that needs a runtime. Registration writes
 * a launcher that runs the app's own executable as Node on that script, so the
 * host works without Node installed, and points the manifest at the launcher.
 * The manifest allows exactly one extension origin. Registration is idempotent
 * and covers Chrome, Chromium, and Edge on Linux and macOS; Windows needs the
 * registry key in addition to the manifest file.
 */

export const BROWSER_CONNECTOR_HOST_NAME = "com.circe.browser_connector";
export const BROWSER_CONNECTOR_EXTENSION_ID = "emjghohcfopghcdlbopgeifkkpfpaphk";

export interface NativeHostRegistrationInput {
  readonly hostScriptPath: string;
  /** The desktop app's executable; it runs the host script as Node. */
  readonly runtimePath: string;
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

const writeIfChanged = (path: string, content: string, mode = 0o644): boolean => {
  let changed = true;
  try {
    changed = NodeFS.readFileSync(path, "utf8") !== content;
  } catch {
    // A missing file is written below.
  }
  if (changed) {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, content, { mode });
  }
  // An existing launcher that lost its execute bit is still not launchable.
  NodeFS.chmodSync(path, mode);
  return changed;
};

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The launcher Chrome executes: the app's executable, as Node, on the host script. */
export const nativeHostLauncher = (input: {
  readonly platform: NodeJS.Platform;
  readonly runtimePath: string;
  readonly hostScriptPath: string;
}): { readonly fileName: string; readonly content: string } =>
  input.platform === "win32"
    ? {
        fileName: "browser-connector-host.cmd",
        content: `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${input.runtimePath}" "${input.hostScriptPath}" %*\r\n`,
      }
    : {
        fileName: "browser-connector-host.sh",
        content: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(input.runtimePath)} ${shellQuote(input.hostScriptPath)} "$@"\n`,
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
  const written: Array<string> = [];
  const skipped: Array<string> = [];
  const launcher = nativeHostLauncher(input);
  const launcherPath = NodePath.join(input.registryManifestDir, "native-host", launcher.fileName);
  if (writeIfChanged(launcherPath, launcher.content, 0o755)) written.push(launcherPath);
  else skipped.push(launcherPath);
  const body = manifestBody(launcherPath);
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
