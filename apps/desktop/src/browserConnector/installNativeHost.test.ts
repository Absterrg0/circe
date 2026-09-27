// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
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
        runtimePath: process.execPath,
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
      // Chrome executes the path, so it names the launcher, not the script.
      expect(manifest.path).toBe(NodePath.join(dir, "native-host", "browser-connector-host.sh"));
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
        runtimePath: process.execPath,
        homeDir: dir,
        platform: "darwin",
        registryManifestDir: dir,
      });
      const second = await registerBrowserConnectorNativeHost({
        hostScriptPath: hostScript,
        runtimePath: process.execPath,
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
        runtimePath: process.execPath,
        homeDir: dir,
        platform: "linux",
        registryManifestDir: dir,
      });
      expect(result).toEqual({ written: [], skipped: [] });
    }));

  // The POSIX launcher needs the shell its interpreter line names.
  it.skipIf(!NodeFS.existsSync("/bin/sh"))(
    "registers a launcher Chrome can execute that speaks native messaging",
    () =>
      withTempDir(async (dir) => {
        // A host with a quote in its path, answering one native-messaging frame.
        const hostScript = NodePath.join(dir, "it's here", "browser-connector-host.cjs");
        NodeFS.mkdirSync(NodePath.dirname(hostScript));
        NodeFS.writeFileSync(
          hostScript,
          `process.stdin.once("data", (frame) => {
            const reply = Buffer.from(JSON.stringify({ echoed: JSON.parse(frame.subarray(4).toString()) }));
            const header = Buffer.alloc(4);
            header.writeUInt32LE(reply.length);
            process.stdout.write(Buffer.concat([header, reply]), () => process.exit(0));
          });`,
        );
        await registerBrowserConnectorNativeHost({
          hostScriptPath: hostScript,
          runtimePath: process.execPath,
          homeDir: dir,
          // The POSIX launcher is the same on Linux and macOS.
          platform: "linux",
          registryManifestDir: dir,
        });
        const manifestDir = NodePath.join(dir, ".config", "google-chrome", "NativeMessagingHosts");
        const manifest = JSON.parse(
          NodeFS.readFileSync(
            NodePath.join(manifestDir, `${BROWSER_CONNECTOR_HOST_NAME}.json`),
            "utf8",
          ),
        ) as { path: string };
        expect(NodeFS.statSync(manifest.path).mode & 0o111).not.toBe(0);

        const message = Buffer.from(JSON.stringify({ type: "hello" }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(message.length);
        const output = NodeChildProcess.execFileSync(manifest.path, [], {
          input: Buffer.concat([header, message]),
        });
        const length = output.readUInt32LE(0);
        expect(JSON.parse(output.subarray(4, 4 + length).toString())).toEqual({
          echoed: { type: "hello" },
        });
      }),
  );
});
