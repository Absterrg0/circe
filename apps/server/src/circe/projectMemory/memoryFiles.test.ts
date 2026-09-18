import { ProjectId, type CirceMemoryEntry } from "@circe/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENTS_BEGIN,
  AGENTS_END,
  parseMemoryFile,
  renderMemoryFile,
  upsertAgentsBlock,
} from "./memoryFiles.ts";

const entry = (title: string): CirceMemoryEntry => ({
  id: "entry-1",
  projectId: ProjectId.make("project-1"),
  kind: "episode",
  source: "agent",
  title,
  body: "body",
  tags: [],
  corroborationCount: 0,
  status: "active",
  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
});

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("project memory files", () => {
  it("round-trips a title containing the comment delimiter", () => {
    const title = "decided to use --> as a separator";
    const parsed = parseMemoryFile(renderMemoryFile(entry(title)));
    expect(parsed?.title).toBe(title);
  });

  it("replaces only the managed block and keeps surrounding user content", () => {
    const existing = `User intro\n\n${AGENTS_BEGIN}\nold block\n${AGENTS_END}\n\nUser outro\n`;
    const next = upsertAgentsBlock(existing, "new block");
    expect(next).toContain("User intro");
    expect(next).toContain("User outro");
    expect(next).toContain("new block");
    expect(next).not.toContain("old block");
    expect(count(next, AGENTS_BEGIN)).toBe(1);
    expect(count(next, AGENTS_END)).toBe(1);
  });

  it("appends without deleting when a begin marker is orphaned", () => {
    const existing = `User notes stay\n${AGENTS_BEGIN}\n`;
    const next = upsertAgentsBlock(existing, "block");
    expect(next).toContain("User notes stay");
    expect(next).toContain("block");
  });

  it("appends without deleting when user text contains only an end marker", () => {
    const existing = `User says ${AGENTS_END} stays\n`;
    const next = upsertAgentsBlock(existing, "block");
    expect(next).toContain(`User says ${AGENTS_END} stays`);
    expect(next).toContain("block");
  });
});
