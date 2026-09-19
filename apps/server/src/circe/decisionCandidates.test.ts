import { describe, expect, it } from "vite-plus/test";

import { extractLocationCandidates } from "./decisionTier.ts";

describe("location candidates", () => {
  it("finds a lowercased place after a preposition", () => {
    expect(extractLocationCandidates("what's the weather in ahmedabad")).toEqual(["ahmedabad"]);
  });

  it("finds a multi-word place in any case", () => {
    expect(extractLocationCandidates("show me the forecast for new york city")).toEqual([
      "new york city",
    ]);
  });

  it("finds several named places in order", () => {
    expect(extractLocationCandidates("weather in Paris and time in Tokyo")).toEqual([
      "Paris",
      "Tokyo",
    ]);
  });

  it("treats a bare place answer as the candidate", () => {
    expect(extractLocationCandidates("Ahmedabad")).toEqual(["Ahmedabad"]);
    expect(extractLocationCandidates("in ahmedabad")).toEqual(["ahmedabad"]);
  });

  it("never invents a place from a question or a command", () => {
    expect(extractLocationCandidates("what's the weather")).toEqual([]);
    expect(extractLocationCandidates("tell me the time")).toEqual([]);
    expect(extractLocationCandidates("open youtube")).toEqual([]);
    expect(extractLocationCandidates("start a task")).toEqual([]);
    expect(extractLocationCandidates("cancel the deploy")).toEqual([]);
  });

  it("keeps a named place inside a longer instruction", () => {
    expect(extractLocationCandidates("what is the weather like in san francisco today")).toEqual([
      "san francisco",
    ]);
  });
});
