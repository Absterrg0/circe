// @effect-diagnostics nodeBuiltinImport:off - this regression inspects source ownership.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const orchestrationHttpPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../orchestration-v2/http.ts",
);

describe("orchestration HTTP ownership", () => {
  it("keeps Circe concepts out of the generic HTTP handlers", () => {
    // Stripping the workspace package scope first; the generic handler imports
    // `@circe/...` modules, and only a Circe *concept* in the body is a
    // boundary violation.
    const source = NodeFS.readFileSync(orchestrationHttpPath, "utf8").replace(
      /"@circe\/[^"]*"/gu,
      "",
    );
    expect(source, orchestrationHttpPath).not.toMatch(/circe/iu);
  });
});
