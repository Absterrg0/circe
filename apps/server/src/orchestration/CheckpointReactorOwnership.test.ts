// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const orchestrationDir = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

describe("checkpoint reactor ownership", () => {
  it("keeps Circe concepts out of generic checkpoint production and tests", () => {
    for (const filename of [
      "CheckpointService.ts",
      "CheckpointCaptureService.ts",
      "CheckpointRollbackService.ts",
      "CheckpointService.test.ts",
      "CheckpointCaptureService.test.ts",
      "CheckpointRollbackService.test.ts",
    ]) {
      const path = NodePath.join(orchestrationDir, "..", "orchestration-v2", filename);
      // Stripping the package-qualified Effect tag keys and the workspace
      // package scope first; every generic module carries `@absterrg0/circe/...`
      // as its DI identifier and imports `@circe/...` modules, and only a
      // Circe *concept* in the body is a boundary violation.
      const source = NodeFS.readFileSync(path, "utf8")
        .replace(/"@absterrg0\/circe\/[^"]*"/gu, "")
        .replace(/"@circe\/[^"]*"/gu, "");
      expect(source, path).not.toMatch(/circe/iu);
    }
  });
});
