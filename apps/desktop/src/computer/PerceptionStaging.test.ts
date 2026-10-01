// @effect-diagnostics nodeBuiltinImport:off - the staging test owns a real temp directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { readBundledCatalog, stagePerception } from "./PerceptionStaging.ts";

const setup = async (archive: Buffer, archiveName = "bundle.tar.gz") => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "circe-staging-"));
  const bundledCatalog = NodePath.join(directory, "signed-catalog.json");
  await NodeFSP.writeFile(
    bundledCatalog,
    JSON.stringify({
      payload: {
        version: "1.0.0",
        archive: archiveName,
        archive_size: archive.length,
        archive_sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
      },
    }),
  );
  return {
    directory,
    source: {
      bundledCatalog,
      archiveUrl: "https://example.invalid/bundle.tar.gz",
      stagingDirectory: NodePath.join(directory, "staging"),
    },
  };
};

describe("perception staging", () => {
  it("stages the catalog beside a verified archive and reuses it", async () => {
    const archive = Buffer.from("signed bytes");
    const { source } = await setup(archive);
    const catalog = await readBundledCatalog(source.bundledCatalog);
    let fetches = 0;
    const fetchArchive = async () => {
      fetches += 1;
      return new Response(archive);
    };
    const staged = await stagePerception(source, catalog, { fetch: fetchArchive });
    expect(NodePath.dirname(staged)).toBe(source.stagingDirectory);
    expect(await NodeFSP.readFile(NodePath.join(source.stagingDirectory, "bundle.tar.gz"))).toEqual(
      archive,
    );
    await stagePerception(source, catalog, { fetch: fetchArchive });
    expect(fetches).toBe(1);
  });

  it("rejects an archive that differs from the signed catalog and keeps nothing", async () => {
    const { source } = await setup(Buffer.from("signed bytes"));
    const catalog = await readBundledCatalog(source.bundledCatalog);
    await expect(
      stagePerception(source, catalog, { fetch: async () => new Response("tampered!!!!") }),
    ).rejects.toThrow(/does not match its signed catalog/);
    await expect(
      stagePerception(source, catalog, {
        fetch: async () => new Response("far too many bytes here"),
      }),
    ).rejects.toThrow(/larger than its signed catalog allows/);
    expect(await NodeFSP.readdir(source.stagingDirectory)).toEqual(["signed-catalog.json"]);
  });

  it("rejects a disk failure while writing instead of throwing from the stream", async () => {
    const archive = Buffer.from("signed bytes");
    const { source } = await setup(archive);
    const catalog = await readBundledCatalog(source.bundledCatalog);
    // A directory where the partial file belongs makes the write stream fail.
    await NodeFSP.mkdir(NodePath.join(source.stagingDirectory, "bundle.tar.gz.partial"), {
      recursive: true,
    });
    await expect(
      stagePerception(source, catalog, { fetch: async () => new Response(archive) }),
    ).rejects.toThrow(/EISDIR|illegal operation on a directory/);
  });

  it("refuses a catalog that names a path outside the staging directory", async () => {
    const { source } = await setup(Buffer.from("x"), "../escape.tar.gz");
    await expect(readBundledCatalog(source.bundledCatalog)).rejects.toThrow(/unsafe archive path/);
  });
});
