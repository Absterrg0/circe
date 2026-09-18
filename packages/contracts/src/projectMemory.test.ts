import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CirceMemoryFetchInput,
  CirceMemoryFetchResult,
  CirceMemoryIndexInput,
  CirceMemoryUpsertInput,
} from "./projectMemory.ts";

const decodeFetchInput = Schema.decodeUnknownSync(CirceMemoryFetchInput);
const decodeFetchResult = Schema.decodeUnknownSync(CirceMemoryFetchResult);
const decodeIndexInput = Schema.decodeUnknownSync(CirceMemoryIndexInput);
const decodeUpsert = Schema.decodeUnknownSync(CirceMemoryUpsertInput);

describe("project memory contracts", () => {
  it("decodes the memory tool inputs", () => {
    expect(decodeIndexInput({ projectId: "project-1" })).toEqual({ projectId: "project-1" });
    expect(decodeFetchInput({ projectId: "project-1", entryId: "mem_1" })).toMatchObject({
      entryId: "mem_1",
    });
    expect(() => decodeFetchInput({ projectId: "project-1" })).toThrow();
  });

  it("decodes a fetch result with and without text", () => {
    expect(decodeFetchResult({ found: false })).toEqual({ found: false });
    expect(decodeFetchResult({ found: true, text: "Recalled fact..." })).toMatchObject({
      found: true,
    });
  });

  it("requires a kind and source on a memory write", () => {
    expect(
      decodeUpsert({
        projectId: "project-1",
        kind: "episode",
        source: "agent",
        title: "A thing",
        body: "happened",
      }),
    ).toMatchObject({ kind: "episode" });
    expect(() =>
      decodeUpsert({ projectId: "project-1", title: "A thing", body: "happened" }),
    ).toThrow();
  });
});
