// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const orbDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

/**
 * Source without comments. The renderer documents this trap by name, and a
 * guard that also flags the explanation would push the explanation out.
 */
function read(name: string): string {
  return NodeFS.readFileSync(NodePath.join(orbDir, name), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/**
 * Guards the fiber field against the failure that made it invisible.
 *
 * On this Skia build a `path` prop cannot be animated. Handing it a shared
 * value — however that path was produced — takes the entire canvas down, and
 * Skia's own `usePathInterpolation` fails the quiet way instead: it publishes
 * its interpolated path from a UI-thread reaction that the renderer never
 * hears, so every fiber kept drawing the hook's empty initial path and the orb
 * lost its defining layer. Nothing about the code looked wrong, and no unit
 * test could see a drawn frame, so the constraint is asserted here.
 */
describe("orb fiber field rendering", () => {
  it("keeps every path prop static", () => {
    const source = read("RibbonField.tsx");
    expect(source).not.toContain("usePathInterpolation");
    expect(source).not.toContain("interpolatePaths");
  });

  it("moves the field through transforms instead of path mutation", () => {
    const source = read("RibbonField.tsx");
    expect(source).toContain("translateX");
    // The wave is built once; travel is a transform on the group above it.
    expect(source).toMatch(/useMemo\(\s*\(\)\s*=>\s*buildFilamentPath/);
  });

  it("drives the field from one accumulated travel signal", () => {
    const source = read("CirceOrb.tsx");
    expect(source).toContain("flowSV");
    expect(source).toContain("params.fieldCycleSeconds");
    expect(source).toContain("params.motionScale");
  });
});
