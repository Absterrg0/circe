// @effect-diagnostics nodeBuiltinImport:off - live-test entry: it owns process stdout and
// signal handling for a spawned desktop host.
import { ComputerHost } from "./ComputerHost.ts";

/**
 * Live-test entry point: starts a real desktop computer host, prints its
 * bootstrap envelope as one JSON line on stdout, and closes on SIGTERM or
 * SIGINT. The server live test spawns this file with Node's type stripping so
 * the full service-to-driver chain is exercised without Electron.
 */

const host = new ComputerHost();

const shutdown = async () => {
  await host.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

const bootstrap = await host.listen();
process.stdout.write(`${JSON.stringify(bootstrap)}\n`);
