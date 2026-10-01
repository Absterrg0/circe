// @effect-diagnostics nodeBuiltinImport:off - live-test entry: it owns process stdout and
// signal handling for a spawned desktop host.
import { ComputerHost } from "./ComputerHost.ts";
import { CuaRuntime } from "./CuaRuntime.ts";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as Schema from "effect/Schema";

/**
 * Live-test entry point: starts a real desktop computer host, prints its
 * bootstrap envelope as one JSON line on stdout, and closes on SIGTERM or
 * SIGINT. The server live test spawns this file with Node's type stripping so
 * the full service-to-driver chain is exercised without Electron.
 * CIRCE_LIVE_CUA_HOME points the driver at an isolated state home, such as
 * one where a test perception extension is installed.
 */

const home = process.env.CIRCE_LIVE_CUA_HOME;
const bundledCatalog = process.env.CIRCE_LIVE_PERCEPTION_CATALOG;
if (bundledCatalog !== undefined && !home)
  throw new Error("Perception provisioning tests require an isolated CIRCE_LIVE_CUA_HOME.");
const stagingDirectory = home === undefined ? undefined : NodePath.join(home, "perception-staging");
const distribution =
  bundledCatalog === undefined
    ? undefined
    : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ archiveUrl: Schema.String })))(
        await NodeFSP.readFile(
          NodePath.join(NodePath.dirname(bundledCatalog), "distribution.json"),
          "utf8",
        ),
      );
const host = new ComputerHost(
  home === undefined || home.length === 0
    ? {}
    : {
        runtime: new CuaRuntime({
          home,
          ...(bundledCatalog === undefined
            ? {}
            : {
                perceptionCatalog: NodePath.join(stagingDirectory!, "signed-catalog.json"),
              }),
        }),
        ...(bundledCatalog === undefined
          ? {}
          : {
              perception: {
                bundledCatalog,
                stagingDirectory: stagingDirectory!,
                archiveUrl: distribution!.archiveUrl,
              },
            }),
      },
);

const shutdown = async () => {
  await host.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

const bootstrap = await host.listen();
process.stdout.write(`${JSON.stringify(bootstrap)}\n`);
