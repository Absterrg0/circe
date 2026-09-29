#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - This small raster export CLI is intentionally a synchronous ImageMagick boundary.

/**
 * Render the Circe masters into every existing Circe asset path.
 *
 * Two checked-in 1254px masters are the source of truth: the transparent
 * Prism Orbit mark for in-app use, and the mark on its charcoal tile for app
 * icons and favicons, as on the brand sheet. `--check` renders into
 * a temporary directory and compares bytes, so
 * CI can catch a stale platform or web asset without mutating the checkout.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const markSource = NodePath.join(repoRoot, "assets/circe/circe-master.png");
const iconSource = NodePath.join(repoRoot, "assets/circe/circe-app-icon-master.png");
const rasterOutputs = [
  ["assets/circe/circe-ios-1024.png", 1024, iconSource],
  ["assets/circe/circe-macos-1024.png", 1024, iconSource],
  ["assets/circe/circe-universal-1024.png", 1024, iconSource],
  ["assets/circe/circe-web-favicon-16x16.png", 16, iconSource],
  ["assets/circe/circe-web-favicon-32x32.png", 32, iconSource],
  ["assets/circe/circe-web-apple-touch-180.png", 180, iconSource],
  ["apps/web/public/circe-mark.png", 256, markSource],
] as const;

const icoOutputs = [
  "assets/circe/circe-web-favicon.ico",
  "assets/circe/circe-windows.ico",
] as const;

function runMagick(args: ReadonlyArray<string>): void {
  NodeChildProcess.execFileSync("magick", args, { cwd: repoRoot, stdio: "pipe" });
}

function renderPng(output: string, size: number, source: string): void {
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  runMagick([
    "-background",
    "none",
    "-density",
    "96",
    source,
    "-resize",
    `${size}x${size}`,
    "-depth",
    "8",
    "-strip",
    "-define",
    "png:compression-level=9",
    `PNG32:${output}`,
  ]);
}

function renderIco(output: string): void {
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  runMagick([
    "-background",
    "none",
    "-density",
    "96",
    iconSource,
    "-define",
    "icon:auto-resize=16,24,32,48,64,128,256",
    "-strip",
    output,
  ]);
}

function generate(destinationRoot: string): void {
  for (const [relativePath, size, source] of rasterOutputs) {
    renderPng(NodePath.join(destinationRoot, relativePath), size, source);
  }
  for (const relativePath of icoOutputs) {
    renderIco(NodePath.join(destinationRoot, relativePath));
  }
}

function assertSource(): void {
  for (const source of [markSource, iconSource]) {
    if (!NodeFS.existsSync(source)) {
      throw new Error(`Missing Circe generated master: ${NodePath.relative(repoRoot, source)}`);
    }
  }
}

function check(): number {
  const stagingRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-assets-"));
  try {
    generate(stagingRoot);
    const stale = [...rasterOutputs.map(([path]) => path), ...icoOutputs].filter((path) => {
      const expected = NodePath.join(repoRoot, path);
      const generated = NodePath.join(stagingRoot, path);
      return (
        !NodeFS.existsSync(expected) ||
        !NodeFS.readFileSync(expected).equals(NodeFS.readFileSync(generated))
      );
    });
    if (stale.length > 0) {
      console.error(`Circe assets are stale:\n${stale.map((path) => `- ${path}`).join("\n")}`);
      return 1;
    }
    console.log("Circe assets are current.");
    return 0;
  } finally {
    NodeFS.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

assertSource();
if (process.argv.includes("--check")) {
  process.exitCode = check();
} else {
  generate(repoRoot);
  console.log(
    `Generated ${rasterOutputs.length + icoOutputs.length} Circe assets from the mark and app icon masters.`,
  );
}
