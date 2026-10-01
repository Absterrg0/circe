import { describe, expect, it } from "vite-plus/test";

import { spokenWords } from "./spokenWords.ts";

describe("spokenWords", () => {
  it("leaves nothing of a transcript that only marks a sound", () => {
    expect(spokenWords("[clear throat")).toBe("");
    expect(spokenWords("[clears throat]")).toBe("");
    expect(spokenWords("(coughs)")).toBe("");
    expect(spokenWords("[BLANK_AUDIO]")).toBe("");
    expect(spokenWords("*sighs*")).toBe("");
  });

  it("keeps the words around a sound mark", () => {
    expect(spokenWords("[clears throat] open the calculator")).toBe("open the calculator");
    expect(spokenWords("Open Spotify (laughs) please")).toBe("Open Spotify please");
  });

  it("keeps brackets that are not sounds", () => {
    expect(spokenWords("rename it to [draft] (v2)")).toBe("rename it to [draft] (v2)");
    expect(spokenWords("see [the docs](https://example.com)")).toBe(
      "see [the docs](https://example.com)",
    );
  });
});
