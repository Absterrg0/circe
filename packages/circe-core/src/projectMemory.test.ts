import { describe, expect, it } from "vite-plus/test";

import {
  buildMemoryIndex,
  estimateMemoryTokens,
  memoryIsLive,
  memoryMayBeFact,
  renderMemoryIndex,
  type CirceMemoryView,
} from "./projectMemory.ts";

const entry = (overrides: Partial<CirceMemoryView>): CirceMemoryView => ({
  id: "m1",
  kind: "episode",
  source: "agent",
  title: "A thing happened",
  body: "body",
  tags: [],
  status: "active",
  updatedAtMs: 1_000,
  expiresAtMs: null,
  ...overrides,
});

describe("memory liveness", () => {
  it("keeps only active, unexpired entries", () => {
    expect(memoryIsLive(entry({}), 0)).toBe(true);
    expect(memoryIsLive(entry({ status: "retired" }), 0)).toBe(false);
    expect(memoryIsLive(entry({ expiresAtMs: 500 }), 1_000)).toBe(false);
    expect(memoryIsLive(entry({ expiresAtMs: 2_000 }), 1_000)).toBe(true);
  });
});

describe("memory promotion", () => {
  it("refuses system content as a fact", () => {
    expect(memoryMayBeFact({ source: "system", corroborationCount: 9, confirmed: true })).toBe(
      false,
    );
  });

  it("promotes on explicit confirmation", () => {
    expect(memoryMayBeFact({ source: "user", corroborationCount: 0, confirmed: true })).toBe(true);
  });

  it("promotes an agent claim only after corroboration", () => {
    expect(memoryMayBeFact({ source: "agent", corroborationCount: 1, confirmed: false })).toBe(
      false,
    );
    expect(memoryMayBeFact({ source: "agent", corroborationCount: 2, confirmed: false })).toBe(
      true,
    );
  });
});

describe("memory index", () => {
  it("ranks facts first, then recency", () => {
    const { entries } = buildMemoryIndex(
      [
        entry({ id: "e-new", kind: "episode", updatedAtMs: 5_000 }),
        entry({ id: "f-old", kind: "fact", updatedAtMs: 1_000 }),
        entry({ id: "f-new", kind: "fact", updatedAtMs: 3_000 }),
      ],
      { nowMs: 10_000 },
    );
    expect(entries.map((item) => item.id)).toEqual(["f-new", "f-old", "e-new"]);
  });

  it("stops at the token budget", () => {
    const body = "x".repeat(400);
    const { entries, totalTokens } = buildMemoryIndex(
      [
        entry({ id: "a", body, updatedAtMs: 3 }),
        entry({ id: "b", body, updatedAtMs: 2 }),
        entry({ id: "c", body, updatedAtMs: 1 }),
      ],
      { nowMs: 10, budgetTokens: 150 },
    );
    expect(entries).toHaveLength(1);
    expect(totalTokens).toBe(estimateMemoryTokens(body));
  });

  it("renders a map with a fetch instruction and nothing when empty", () => {
    expect(renderMemoryIndex({ entries: [], totalTokens: 0 })).toBe("");
    const { entries, totalTokens } = buildMemoryIndex([entry({ id: "f1", kind: "fact" })], {
      nowMs: 10,
    });
    const block = renderMemoryIndex({ entries, totalTokens });
    expect(block).toContain("[fact/agent]");
    expect(block).toContain("id f1");
    expect(block).toContain("Fetch a body by id");
  });

  it("omits retired and expired entries", () => {
    const { entries } = buildMemoryIndex(
      [
        entry({ id: "live" }),
        entry({ id: "retired", status: "retired" }),
        entry({ id: "expired", expiresAtMs: 1 }),
      ],
      { nowMs: 10 },
    );
    expect(entries.map((item) => item.id)).toEqual(["live"]);
  });
});
