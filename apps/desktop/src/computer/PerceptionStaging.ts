// @effect-diagnostics nodeBuiltinImport:off -- Staging streams a large archive to disk next to
// the driver's catalog; it runs inside the plain-TypeScript computer host.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type * as NodeStreamWeb from "node:stream/web";

import * as Schema from "effect/Schema";

/**
 * Where Circe's perception extension comes from. The app ships only the
 * signed catalog for its own target; the archive it names is fetched on first
 * need into a staging directory beside a copy of that catalog, because the
 * Cua driver installs an archive from the catalog's directory. Circe checks
 * the archive's size and digest against the signed payload before handing it
 * over, and the driver then verifies the signature and every hash itself.
 */
export interface PerceptionSource {
  /** The signed catalog shipped in the app's resources. */
  readonly bundledCatalog: string;
  /** Immutable release URL of the archive the catalog names. */
  readonly archiveUrl: string;
  /** Circe-owned directory the driver's catalog path points into. */
  readonly stagingDirectory: string;
}

const CatalogPayload = Schema.Struct({
  payload: Schema.Struct({
    version: Schema.String,
    archive: Schema.String,
    archive_size: Schema.Number,
    archive_sha256: Schema.String,
  }),
});
const decodeCatalog = Schema.decodeUnknownOption(Schema.fromJsonString(CatalogPayload));

export interface BundledCatalog {
  readonly version: string;
  readonly archive: string;
  readonly archiveSize: number;
  readonly archiveSha256: string;
  readonly bytes: Buffer;
}

export const readBundledCatalog = async (path: string): Promise<BundledCatalog> => {
  const bytes = await NodeFSP.readFile(path);
  const decoded = decodeCatalog(bytes.toString("utf8"));
  if (decoded._tag === "None") throw new Error("the bundled perception catalog is malformed");
  const payload = decoded.value.payload;
  if (NodePath.basename(payload.archive) !== payload.archive || payload.archive.startsWith("."))
    throw new Error("the bundled perception catalog names an unsafe archive path");
  if (!/^[0-9a-f]{64}$/.test(payload.archive_sha256))
    throw new Error("the bundled perception catalog has a malformed archive digest");
  return {
    version: payload.version,
    archive: payload.archive,
    archiveSize: payload.archive_size,
    archiveSha256: payload.archive_sha256,
    bytes,
  };
};

const digestOf = async (path: string): Promise<{ size: number; sha256: string } | undefined> => {
  try {
    const hash = NodeCrypto.createHash("sha256");
    let size = 0;
    for await (const chunk of NodeFS.createReadStream(path)) {
      size += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
    return { size, sha256: hash.digest("hex") };
  } catch {
    return undefined;
  }
};

export type ArchiveFetch = (url: string, signal: AbortSignal) => Promise<Response>;

/**
 * Put the catalog and its archive side by side in the staging directory and
 * return the staged catalog path. An archive already staged with the signed
 * digest is reused; anything else is downloaded to a partial file, bounded by
 * the signed size, checked, and renamed into place.
 */
export const stagePerception = async (
  source: PerceptionSource,
  catalog: BundledCatalog,
  options: { readonly fetch?: ArchiveFetch; readonly signal?: AbortSignal } = {},
): Promise<string> => {
  await NodeFSP.mkdir(source.stagingDirectory, { recursive: true, mode: 0o700 });
  const stagedCatalog = NodePath.join(source.stagingDirectory, "signed-catalog.json");
  await NodeFSP.writeFile(stagedCatalog, catalog.bytes, { mode: 0o600 });
  const archive = NodePath.join(source.stagingDirectory, catalog.archive);
  const existing = await digestOf(archive);
  if (existing?.size === catalog.archiveSize && existing.sha256 === catalog.archiveSha256)
    return stagedCatalog;
  const partial = `${archive}.partial`;
  const response = await (options.fetch ?? fetch)(
    source.archiveUrl,
    options.signal ?? new AbortController().signal,
  );
  if (!response.ok || response.body === null)
    throw new Error(`the perception archive download failed with HTTP ${response.status}`);
  const hash = NodeCrypto.createHash("sha256");
  let size = 0;
  // One pipeline: a read, bound, or disk error rejects it and closes every
  // stream, so nothing escapes as an unhandled stream event.
  const bounded = new NodeStream.Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > catalog.archiveSize) {
        done(new Error("the perception archive is larger than its signed catalog allows"));
        return;
      }
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await NodeStreamPromises.pipeline(
      NodeStream.Readable.fromWeb(response.body as unknown as NodeStreamWeb.ReadableStream),
      bounded,
      NodeFS.createWriteStream(partial, { mode: 0o600 }),
      ...(options.signal === undefined ? [] : [{ signal: options.signal }]),
    );
    if (size !== catalog.archiveSize || hash.digest("hex") !== catalog.archiveSha256)
      throw new Error("the perception archive does not match its signed catalog");
    await NodeFSP.rename(partial, archive);
    return stagedCatalog;
  } catch (error) {
    await NodeFSP.rm(partial, { force: true });
    throw error;
  }
};

/** Drop the staged archive once the driver has copied it into its store. */
export const releaseStagedArchive = (source: PerceptionSource, catalog: BundledCatalog) =>
  NodeFSP.rm(NodePath.join(source.stagingDirectory, catalog.archive), { force: true });
