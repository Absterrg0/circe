// @effect-diagnostics nodeBuiltinImport:off - fixtures exercise the standalone Node archive gate.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import {
  auditPerceptionArchive,
  readTarGz,
  verifyPerceptionCatalog,
} from "./check-cua-perception.ts";

/** A minimal ustar archive of regular files, gzip-compressed. */
const tarGz = (files: Record<string, Buffer | string>): Buffer => {
  const blocks: Array<Buffer> = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return NodeZlib.gzipSync(Buffer.concat(blocks));
};

const clean = {
  "notices/MIT-OmniParser-icon_detect_v3.txt": "MIT",
  "notices/Apache-2.0.txt": "Apache",
  "notices/onnxruntime-LICENSE.txt": "MIT",
  "notices/THIRD_PARTY_NOTICES.md": "notices",
  "metadata/sbom.spdx.json": JSON.stringify({ packages: [{ licenseConcluded: "MIT" }] }),
  "models/detector.onnx": "weights",
};

describe("Cua Perception release gate", () => {
  it("verifies publisher signatures and rejects altered or expired catalogs", () => {
    const target = "x86_64-unknown-linux-gnu";
    const catalog = JSON.parse(
      NodeFS.readFileSync(
        new URL(
          `../apps/desktop/resources/cua-perception/${target}/signed-catalog.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const now = 1790758200;
    expect(verifyPerceptionCatalog(catalog, target, now)).toEqual([]);
    expect(
      verifyPerceptionCatalog(
        { ...catalog, payload: { ...catalog.payload, version: "99.0.0" } },
        target,
        now,
      ),
    ).toContain("the catalog signature is invalid");
    expect(verifyPerceptionCatalog({ ...catalog, signature: "invalid" }, target, now)).toContain(
      "the catalog signature is invalid",
    );
    expect(verifyPerceptionCatalog(catalog, target, catalog.payload.expires_unix)).toContain(
      "the catalog is expired",
    );
    expect(verifyPerceptionCatalog(catalog, "aarch64-apple-darwin", now)).toContain(
      "the catalog target does not match its directory",
    );
    expect(verifyPerceptionCatalog(null, target, now)).toContain("the catalog is malformed");
  });

  it("rejects malformed SBOMs and production Python or PyTorch while allowing export source", () => {
    const malformed = auditPerceptionArchive(
      tarGz({ ...clean, "metadata/sbom.spdx.json": "invalid" }),
    );
    expect(malformed).toContain("the SBOM is malformed");
    const runtime = auditPerceptionArchive(
      tarGz({
        ...clean,
        "runtime/python3": "interpreter",
        "runtime/site-packages/torch/__init__.py": "runtime",
        "source/export_icon_detect_v3.py": "build-only conversion",
      }),
    );
    expect(runtime).toContain("runtime/python3 is a prohibited runtime dependency");
    expect(runtime).toContain(
      "runtime/site-packages/torch/__init__.py is a prohibited runtime dependency",
    );
    expect(runtime.some((problem) => problem.includes("source/export"))).toBe(false);
  });

  it("reads the files of a tar.gz", () => {
    expect(readTarGz(tarGz({ "a/b.txt": "hello" }))).toEqual([
      { path: "a/b.txt", data: Buffer.from("hello") },
    ]);
  });

  it("passes a permissive archive with its notices and SBOM", () => {
    expect(auditPerceptionArchive(tarGz(clean))).toEqual([]);
  });

  it("finds a prohibited artifact under any name, even inside a nested source archive", () => {
    const agpl = Buffer.from("retired detector weights");
    const digest = NodeCrypto.createHash("sha256").update(agpl).digest("hex");
    const archive = tarGz({
      ...clean,
      "source/cua-perception-source.tar.gz": tarGz({ "snapshot/innocent.bin": agpl }),
    });
    expect(auditPerceptionArchive(archive, new Map([[digest, "retired detector"]]))).toEqual([
      "source/cua-perception-source.tar.gz!/snapshot/innocent.bin is the retired detector",
    ]);
  });

  it("rejects prohibited names, copyleft SBOM entries and missing notices", () => {
    const files: Record<string, Buffer | string> = {
      ...clean,
      "source/ultralytics-8f7fe17.tar.gz": tarGz({ "x.py": "print()" }),
      "metadata/sbom.spdx.json": JSON.stringify({
        packages: [{ licenseConcluded: "AGPL-3.0-only" }],
      }),
    };
    delete files["notices/Apache-2.0.txt"];
    const problems = auditPerceptionArchive(tarGz(files));
    expect(problems).toContain(
      "source/ultralytics-8f7fe17.tar.gz has a prohibited name (ultralytics)",
    );
    expect(
      problems.some((problem) => problem.startsWith("the SBOM declares a copyleft license")),
    ).toBe(true);
    expect(problems).toContain("missing Apache-2.0.txt");
  });
});
