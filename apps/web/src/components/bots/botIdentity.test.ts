import { describe, expect, it } from "vite-plus/test";

import { botMonogram, botTint } from "./botIdentity";

describe("bot identity", () => {
  it("builds monograms from the first two words", () => {
    expect(botMonogram("YT desk")).toBe("YD");
    expect(botMonogram("research")).toBe("RE");
    expect(botMonogram("  ✦ ops ✦ ")).toBe("OP");
    expect(botMonogram("✦")).toBe("?");
  });

  it("keeps a bot's tint stable for its id", () => {
    expect(botTint("yt")).toBe(botTint("yt"));
    expect(botTint("yt")).toMatch(/^linear-gradient/);
  });
});
