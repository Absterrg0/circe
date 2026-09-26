#!/usr/bin/env node
/**
 * Installs circe-core (`@absterrg0/circe-core`), Circe's private
 * interpretation core, into apps/server when a token can read it. It is not a
 * declared dependency, so public checkouts install and build without it; the
 * server then runs with the Circe host layer off (see
 * apps/server/src/circe/host/core.ts). A server bundle built with it
 * installed includes it.
 *
 * The token is CIRCE_CORE_TOKEN, or else the GitHub CLI's, and needs
 * read:packages on Absterrg0/circe-core. Runs on every `pnpm install`,
 * including filtered installs, so it uses Node alone and never fails the
 * install, except when the download does not match its pinned integrity. To
 * take a new version, update VERSION and INTEGRITY.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const NAME = "@absterrg0/circe-core";
const VERSION = "0.1.0";
const INTEGRITY =
  "sha512-7OmfH1MQcEhub+fCt1gp1wjErqTv8fY4OrxuMLEE6x5g6juRreBaec3zB5suymRiCxx6KU/KYaNTWvV+sqZrDQ==";
const REGISTRY = "https://npm.pkg.github.com";

const target = NodePath.join(
  NodeURL.fileURLToPath(new URL("..", import.meta.url)),
  "apps",
  "server",
  "node_modules",
  ...NAME.split("/"),
);

function installedVersion() {
  try {
    return JSON.parse(NodeFS.readFileSync(NodePath.join(target, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

function token() {
  const fromEnv = process.env.CIRCE_CORE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromGh = NodeChildProcess.execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return fromGh.length > 0 ? fromGh : undefined;
  } catch {
    return undefined;
  }
}

/** The package's tarball, or why it could not be fetched. */
async function download(auth) {
  const headers = { authorization: `Bearer ${auth}` };
  const metadata = await fetch(`${REGISTRY}/${NAME.replace("/", "%2f")}`, { headers });
  if (!metadata.ok) return `the registry answered ${metadata.status}`;
  const tarball = (await metadata.json()).versions?.[VERSION]?.dist?.tarball;
  if (typeof tarball !== "string") return `version ${VERSION} is not published`;
  const response = await fetch(tarball, { headers });
  if (!response.ok) return `the tarball download answered ${response.status}`;
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Windows (the only platform that sets SystemRoot) ships bsdtar in System32; a
 * Git Bash GNU tar earlier on PATH cannot take C:\ paths.
 */
function tarCommand() {
  const systemRoot = process.env.SystemRoot;
  return systemRoot === undefined ? "tar" : `${systemRoot}\\System32\\tar.exe`;
}

function extract(bytes) {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-core-"));
  try {
    const file = NodePath.join(scratch, "package.tgz");
    NodeFS.writeFileSync(file, bytes);
    NodeFS.rmSync(target, { recursive: true, force: true });
    NodeFS.mkdirSync(target, { recursive: true });
    NodeChildProcess.execFileSync(tarCommand(), [
      "-xzf",
      file,
      "-C",
      target,
      "--strip-components=1",
    ]);
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

function skip(reason) {
  console.log(`circe-core not installed (${reason}); the Circe host layer will be off.`);
}

async function main() {
  if (installedVersion() === VERSION) return;
  const auth = token();
  if (auth === undefined) return skip("no token");
  let fetched;
  try {
    fetched = await download(auth);
  } catch (error) {
    return skip(error instanceof Error ? error.message : String(error));
  }
  if (typeof fetched === "string") return skip(fetched);
  const integrity = `sha512-${NodeCrypto.createHash("sha512").update(fetched).digest("base64")}`;
  if (integrity !== INTEGRITY) {
    console.error(`circe-core ${VERSION} does not match its pinned integrity; not installed.`);
    process.exitCode = 1;
    return;
  }
  try {
    extract(fetched);
  } catch (error) {
    return skip(`extracting failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`circe-core ${VERSION} installed.`);
}

await main();
