// @effect-diagnostics nodeBuiltinImport:off - a release gate over files and archives on disk.
// @effect-diagnostics globalDate:off - catalog expiry must work before workspace dependencies are installed.
// @effect-diagnostics globalFetch:off - CI invokes this standalone Node gate before installing dependencies.
// @effect-diagnostics globalConsole:off - this standalone release gate reports diagnostics to CI stdout/stderr.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

/**
 * Release gate for the Cua Perception extension Circe distributes.
 *
 * Circe ships each target's signed catalog and the release URL of the archive
 * it names. This gate checks that pairing and, with `--download`, fetches every
 * archive, checks it against its signed catalog, and walks every file in it,
 * including nested tar.gz source archives. It fails when the archive carries
 * the retired AGPL OmniParser detector (its weights, its ONNX conversion, or
 * the Ultralytics exporter source bundled for it), any other prohibited name,
 * a copyleft license in its SBOM, or lacks the license texts and notices.
 *
 * Usage: node scripts/check-cua-perception.ts [--download] [resource-dir]
 */

/** Digests of the AGPL detector artifacts that must never ship again. */
export const PROHIBITED_DIGESTS: ReadonlyMap<string, string> = new Map([
  [
    "dab3d4351ad00b035db829909a4db98354d5a90f6990e4ac00222a9a95d4bf57",
    "AGPL OmniParser icon_detect weights",
  ],
  [
    "d8a876bf7f9fb73d7da9432904ade7fa78e092e9a91674e5a2806b45562a9ab2",
    "AGPL OmniParser icon_detect ONNX conversion",
  ],
  [
    "6c289215a5ce593a872111b87e58ffff6949d235c2af720e8f01704375f7bf44",
    "AGPL Ultralytics exporter source",
  ],
]);
const PROHIBITED_NAMES = [
  "ultralytics",
  "omniparser-icon-detect-model",
  "omniparser-icon-detect-1280",
];
const COPYLEFT = /\b(A?GPL|LGPL)-/;
/** License texts and notices by file name; the SBOM by its fixed path. */
const REQUIRED_NOTICES = [
  "MIT-OmniParser-icon_detect_v3.txt",
  "Apache-2.0.txt",
  "onnxruntime-LICENSE.txt",
  "THIRD_PARTY_NOTICES.md",
];
const REQUIRED_SBOM = "metadata/sbom.spdx.json";

export interface ArchiveEntry {
  readonly path: string;
  readonly data: Buffer;
}

/** Regular files of a (gzip-compressed) ustar archive. */
export const readTarGz = (archive: Buffer): ReadonlyArray<ArchiveEntry> => {
  const tar = NodeZlib.gunzipSync(archive);
  const entries: Array<ArchiveEntry> = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length)
      throw new Error("The tar archive has an invalid or truncated entry.");
    const type = field(156, 1);
    const prefix = field(345, 155);
    const name = longName ?? (prefix.length > 0 ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    const data = tar.subarray(offset + 512, offset + 512 + size);
    if (type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "0" || type === "") entries.push({ path: name, data: Buffer.from(data) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
};

const sha256 = (data: Buffer) => NodeCrypto.createHash("sha256").update(data).digest("hex");

/** Every problem with one extension archive; empty means it may ship. */
export const auditPerceptionArchive = (
  archive: Buffer,
  prohibitedDigests: ReadonlyMap<string, string> = PROHIBITED_DIGESTS,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const visit = (entries: ReadonlyArray<ArchiveEntry>, within: string) => {
    for (const entry of entries) {
      const where = `${within}${entry.path}`;
      const lowered = where.toLowerCase();
      const runtime = lowered.replace(/^\.\//, "").startsWith("runtime/");
      if (
        runtime &&
        /(^|\/)(python[^/]*|libpython[^/]*|torch|pytorch)(\/|$)|\.(py|pyc|pt|pth)$/.test(lowered)
      )
        problems.push(`${where} is a prohibited runtime dependency`);
      const name = PROHIBITED_NAMES.find((marker) => lowered.includes(marker));
      if (name !== undefined) problems.push(`${where} has a prohibited name (${name})`);
      const prohibited = prohibitedDigests.get(sha256(entry.data));
      if (prohibited !== undefined) problems.push(`${where} is the ${prohibited}`);
      if (entry.path.endsWith(".tar.gz")) {
        try {
          visit(readTarGz(entry.data), `${where}!/`);
        } catch {
          problems.push(`${where} is not a readable tar.gz`);
        }
      }
    }
  };
  const entries = readTarGz(archive);
  visit(entries, "");
  const paths = entries.map((entry) => entry.path.replace(/^\.\//, ""));
  for (const notice of REQUIRED_NOTICES)
    if (!paths.some((path) => NodePath.posix.basename(path) === notice))
      problems.push(`missing ${notice}`);
  if (!paths.includes(REQUIRED_SBOM)) problems.push(`missing ${REQUIRED_SBOM}`);
  const sbom = entries.find((entry) => entry.path.endsWith("metadata/sbom.spdx.json"));
  if (sbom !== undefined) {
    const text = sbom.data.toString("utf8");
    try {
      const parsed = JSON.parse(text) as { packages?: Array<{ licenseConcluded?: unknown }> };
      if (
        !Array.isArray(parsed.packages) ||
        parsed.packages.length === 0 ||
        parsed.packages.some((pkg) => typeof pkg?.licenseConcluded !== "string")
      )
        problems.push("the SBOM is malformed");
    } catch {
      problems.push("the SBOM is malformed");
    }
    const match = COPYLEFT.exec(text);
    if (match !== null) problems.push(`the SBOM declares a copyleft license (${match[0]}…)`);
  }
  return problems;
};

interface CatalogPayload {
  readonly version: string;
  readonly target: string;
  readonly archive: string;
  readonly archive_size: number;
  readonly archive_sha256: string;
}

// Matches the publisher root compiled into the pinned fork native packages.
// Rotate this alongside the natives and catalogs, using the fork's trust root.
const PUBLISHER_ROOT = {
  publisherId: "absterrg0",
  keyId: "absterrg0-extension-ed25519-2026-09",
  publicKeyBase64: "9jcWK2xReXSHZoe1XQjaKGrkfxZdxtYEgniRIZBAOc0=",
  validFromUnix: 1790640000,
  validUntilUnix: 2082758400,
};

export const verifyPerceptionCatalog = (
  value: unknown,
  target: string,
  nowUnix = Math.floor(Date.now() / 1000),
): ReadonlyArray<string> => {
  if (value === null || typeof value !== "object") return ["the catalog is malformed"];
  const catalog = value as {
    payload?: Record<string, unknown>;
    signature_algorithm?: unknown;
    signature?: unknown;
  };
  const payload = catalog.payload;
  if (payload === undefined || payload === null || typeof payload !== "object")
    return ["the catalog is malformed"];
  const problems: string[] = [];
  if (
    payload.schema_version !== 1 ||
    payload.extension_id !== "cua-perception" ||
    typeof payload.version !== "string" ||
    typeof payload.archive !== "string" ||
    !Number.isSafeInteger(payload.archive_size) ||
    Number(payload.archive_size) <= 0 ||
    typeof payload.archive_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.archive_sha256)
  )
    problems.push("the catalog is malformed");
  if (payload.target !== target) problems.push("the catalog target does not match its directory");
  if (
    payload.publisher_id !== PUBLISHER_ROOT.publisherId ||
    payload.key_id !== PUBLISHER_ROOT.keyId
  )
    problems.push("the catalog publisher is not trusted by the pinned driver");
  if (nowUnix < PUBLISHER_ROOT.validFromUnix || nowUnix >= PUBLISHER_ROOT.validUntilUnix)
    problems.push("the catalog signing key is outside its validity interval");
  if (!Number.isSafeInteger(payload.expires_unix) || Number(payload.expires_unix) <= nowUnix)
    problems.push("the catalog is expired");
  try {
    const key = NodeCrypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(PUBLISHER_ROOT.publicKeyBase64, "base64"),
      ]),
      format: "der",
      type: "spki",
    });
    if (
      catalog.signature_algorithm !== "ed25519" ||
      typeof catalog.signature !== "string" ||
      !NodeCrypto.verify(
        null,
        Buffer.from(JSON.stringify(payload)),
        key,
        Buffer.from(catalog.signature, "base64"),
      )
    )
      problems.push("the catalog signature is invalid");
  } catch {
    problems.push("the catalog signature is invalid");
  }
  return problems;
};

const checkTarget = async (directory: string, download: boolean) => {
  const problems: Array<string> = [];
  const catalog = JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, "signed-catalog.json"), "utf8"),
  ) as { payload: CatalogPayload; signature_algorithm: string; signature: string };
  const distribution = JSON.parse(
    await NodeFSP.readFile(NodePath.join(directory, "distribution.json"), "utf8"),
  ) as { archiveUrl: string };
  const payload = catalog.payload;
  problems.push(...verifyPerceptionCatalog(catalog, NodePath.basename(directory)));
  if (problems.length > 0) return problems;
  if (!distribution.archiveUrl.startsWith("https://"))
    problems.push("the archive URL is not HTTPS");
  if (NodePath.posix.basename(new URL(distribution.archiveUrl).pathname) !== payload.archive)
    problems.push("the archive URL does not name the catalog's archive");
  if (download) {
    const response = await fetch(distribution.archiveUrl);
    if (!response.ok) problems.push(`the archive download failed with HTTP ${response.status}`);
    else {
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.length !== payload.archive_size || sha256(archive) !== payload.archive_sha256)
        problems.push("the archive does not match its signed catalog");
      else problems.push(...auditPerceptionArchive(archive));
    }
  }
  return problems;
};

const main = async () => {
  const args = process.argv.slice(2);
  const download = args.includes("--download");
  const root = args.find((arg) => !arg.startsWith("--")) ?? "apps/desktop/resources/cua-perception";
  const entries = await NodeFSP.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  });
  const targets = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  let failed = false;
  for (const target of targets) {
    const problems = await checkTarget(NodePath.join(root, target), download);
    for (const problem of problems) console.error(`${target}: ${problem}`);
    if (problems.length > 0) failed = true;
    else console.log(`${target}: ok${download ? " (archive audited)" : ""}`);
  }
  if (targets.length === 0) console.log("no Cua Perception catalogs are bundled");
  process.exitCode = failed ? 1 : 0;
};

if (import.meta.main) await main();
