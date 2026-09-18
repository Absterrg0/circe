// @effect-diagnostics nodeBuiltinImport:off - this regression inspects source ownership.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const reactorPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../orchestration-v2/Orchestrator.ts",
);

describe("orchestration reactor ownership", () => {
  it("keeps Circe concepts out of the generic reactor", () => {
    // Stripping the package-qualified Effect tag keys and the workspace package
    // scope first; the generic module carries `@absterrg0/circe/...` as its DI
    // identifier and imports `@circe/...` modules, and only a Circe *concept*
    // in the body is a boundary violation.
    const source = NodeFS.readFileSync(reactorPath, "utf8")
      .replace(/"@absterrg0\/circe\/[^"]*"/gu, "")
      .replace(/"@circe\/[^"]*"/gu, "");
    expect(source, reactorPath).not.toMatch(/circe/iu);
  });
});
