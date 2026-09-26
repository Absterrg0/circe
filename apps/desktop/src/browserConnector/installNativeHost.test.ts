// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  BROWSER_CONNECTOR_EXTENSION_ID,
  BROWSER_CONNECTOR_HOST_NAME,
  registerBrowserConnectorNativeHost,
} from "./installNativeHost.ts";

const withTempDir = async <A>(use: (dir: string) => Promise<A>): Promise<A> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-native-host-"));
  try {
    return await use(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

describe("browser connector native host registration", () => {
  it("writes the manifest for the installed Chromium browsers", () =>
    withTempDir(async (dir) => {
      const hostScript = NodePath.join(dir, "browser-connector-host.cjs");
      NodeFS.writeFileSync(hostScript, "// host\n");
      const result = await registerBrowserConnectorNativeHost({
        hostScriptPath: hostScript,
        homeDir: dir,
        platform: "linux",
        registryManifestDir: dir,
      });
      expect(result.written.length).toBeGreaterThan(0);
      const manifest = JSON.parse(
        NodeFS.readFileSync(
          NodePath.join(
            dir,
            ".config",
            "google-chrome",
            "NativeMessagingHosts",
            `${BROWSER_CONNECTOR_HOST_NAME}.json`,
          ),
          "utf8",
        ),
      ) as {
        name: string;
        path: string;
        type: string;
        allowed_origins: ReadonlyArray<string>;
      };
      expect(manifest.name).toBe(BROWSER_CONNECTOR_HOST_NAME);
      expect(manifest.path).toBe(hostScript);
      expect(manifest.type).toBe("stdio");
      expect(manifest.allowed_origins).toEqual([
        `chrome-extension://${BROWSER_CONNECTOR_EXTENSION_ID}/`,
      ]);
    }));

  it("is idempotent and skips an unchanged manifest", () =>
    withTempDir(async (dir) => {
      const hostScript = NodePath.join(dir, "browser-connector-host.cjs");
      NodeFS.writeFileSync(hostScript, "// host\n");
      const first = await registerBrowserConnectorNativeHost({
        hostScriptPath: hostScript,
        homeDir: dir,
        platform: "darwin",
        registryManifestDir: dir,
      });
      const second = await registerBrowserConnectorNativeHost({
        hostScriptPath: hostScript,
        homeDir: dir,
        platform: "darwin",
        registryManifestDir: dir,
      });
      expect(first.written.length).toBeGreaterThan(0);
      expect(second.written).toEqual([]);
      expect(second.skipped.length).toBe(first.written.length);
    }));

  it("writes nothing when the host script is missing", () =>
    withTempDir(async (dir) => {
      const result = await registerBrowserConnectorNativeHost({
        hostScriptPath: NodePath.join(dir, "missing.cjs"),
        homeDir: dir,
        platform: "linux",
        registryManifestDir: dir,
      });
      expect(result).toEqual({ written: [], skipped: [] });
    }));
});
