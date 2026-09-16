// @effect-diagnostics nodeBuiltinImport:off - static boundary check over client source trees.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const CLIENT_SOURCES = ["apps/web/src", "apps/mobile/src"];
const SERVER_ONLY_KEY = "CIRCE_TYPESAFE_API_KEY";

const sourceFiles = (root: string): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const walk = (dir: string): void => {
    let entries: ReadonlyArray<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:[cm]?[jt]sx?|json|html)$/u.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
};

describe("decision key boundary", () => {
  it("keeps the TypeSafe key out of every client source tree", () => {
    const offenders: Array<string> = [];
    for (const relative of CLIENT_SOURCES) {
      for (const file of sourceFiles(NodePath.join(REPO_ROOT, relative))) {
        if (NodeFS.readFileSync(file, "utf8").includes(SERVER_ONLY_KEY)) {
          offenders.push(NodePath.relative(REPO_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only references the key in the server CLI config", () => {
    const referenced = sourceFiles(NodePath.join(REPO_ROOT, "apps/server/src")).some((file) =>
      NodeFS.readFileSync(file, "utf8").includes(SERVER_ONLY_KEY),
    );
    expect(referenced).toBe(true);
  });
});
