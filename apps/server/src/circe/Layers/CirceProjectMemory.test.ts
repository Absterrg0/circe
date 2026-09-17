import { ProjectId } from "@circe/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { CirceProjectMemory } from "../Services/CirceProjectMemory.ts";
import { make } from "./CirceProjectMemory.ts";

const projectId = ProjectId.make("project-memory-test");

const layer = Layer.effect(CirceProjectMemory, make).pipe(
  Layer.provide(Layer.mock(Crypto.Crypto)({ randomUUIDv4: Effect.succeed("uuid-1") })),
);

const withMemory = <A, E>(
  program: (memory: CirceProjectMemory["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const memory = yield* CirceProjectMemory;
    return yield* program(memory);
  }).pipe(Effect.provide(layer));

describe("project memory store", () => {
  it("stores an episode and returns it in the index", () => {
    const result = Effect.runSync(
      withMemory((memory) =>
        Effect.gen(function* () {
          yield* memory.remember({
            projectId,
            kind: "episode",
            source: "agent",
            title: "Found the test command",
            body: "vp test run <files> is the focused check.",
          });
          const index = yield* memory.index(projectId);
          const list = yield* memory.list(projectId);
          return { index, list };
        }),
      ),
    );
    expect(result.index.entries).toHaveLength(1);
    expect(result.index.entries[0]?.title).toBe("Found the test command");
    expect(result.index.totalTokens).toBeGreaterThan(0);
    expect(result.list[0]?.corroborationCount).toBe(0);
  });

  it("refuses an uncorroborated agent fact and allows a confirmed one", () => {
    const refused = Effect.runSyncExit(
      withMemory((memory) =>
        memory.remember({
          projectId,
          kind: "fact",
          source: "agent",
          title: "Uses pnpm",
          body: "pnpm is the package manager.",
        }),
      ),
    );
    expect(refused._tag).toBe("Failure");

    const accepted = Effect.runSync(
      withMemory((memory) =>
        memory.remember({
          projectId,
          kind: "fact",
          source: "user",
          title: "Uses pnpm",
          body: "pnpm is the package manager.",
          confirmed: true,
        }),
      ),
    );
    expect(accepted.kind).toBe("fact");
    expect(accepted.expiresAt).not.toBeNull();
  });

  it("corroborates a repeated claim instead of duplicating it", () => {
    const list = Effect.runSync(
      withMemory((memory) =>
        Effect.gen(function* () {
          yield* memory.remember({
            projectId,
            kind: "episode",
            source: "agent",
            title: "Runner is flaky",
            body: "First observation.",
          });
          yield* memory.remember({
            projectId,
            kind: "episode",
            source: "agent",
            title: "  runner IS flaky ",
            body: "Second observation.",
          });
          return yield* memory.list(projectId);
        }),
      ),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.corroborationCount).toBe(1);
  });

  it("retires a forgotten entry so it leaves the index", () => {
    const result = Effect.runSync(
      withMemory((memory) =>
        Effect.gen(function* () {
          const entry = yield* memory.remember({
            projectId,
            kind: "episode",
            source: "agent",
            title: "Temporary note",
            body: "Delete me.",
          });
          const forget = yield* memory.forget({ projectId, entryId: entry.id });
          const index = yield* memory.index(projectId);
          return { forget, index };
        }),
      ),
    );
    expect(result.forget.forgotten).toBe(true);
    expect(result.index.entries).toHaveLength(0);
  });
});
