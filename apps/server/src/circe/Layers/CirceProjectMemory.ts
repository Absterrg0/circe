import type { CirceMemoryEntry, CirceMemoryIndex, CirceMemoryUpsertInput } from "@circe/contracts";
import { buildMemoryIndex, memoryMayBeFact, type CirceMemoryView } from "@circe/core/projectMemory";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  CIRCE_DIR,
  INDEX_FILE,
  MEMORY_DIR,
  RETIRED_DIR,
  parseMemoryFile,
  renderMemoryFile,
} from "../projectMemory/memoryFiles.ts";
import {
  CirceMemoryPromotionError,
  CirceMemoryStoreError,
  CirceProjectMemory,
  type CirceProjectMemoryShape,
} from "../Services/CirceProjectMemory.ts";
import { renderMemoryIndex } from "@circe/core/projectMemory";

/**
 * File-backed project memory. Every entry is a markdown file under
 * `<workspaceRoot>/.circe/memory/` with a machine-readable header; retired
 * entries move to `retired/` so provenance is never destroyed. The same
 * `AGENTS.md` that providers already read carries a managed map.
 */
const FACT_TTL_DAYS = 90;

const normalizeTitle = (title: string): string => title.trim().toLowerCase().replace(/\s+/gu, " ");

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const storeError = (projectId: string, operation: string, cause?: unknown) =>
    new CirceMemoryStoreError({
      projectId: projectId as CirceMemoryEntry["projectId"],
      operation,
      ...(cause === undefined ? {} : { cause }),
    });

  const workspaceRoot = (projectId: string) =>
    projections.getProjectShellById(projectId as CirceMemoryEntry["projectId"]).pipe(
      Effect.mapError((cause) => storeError(projectId, "resolve the project workspace", cause)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(storeError(projectId, "resolve the project workspace")),
          onSome: (project) => Effect.succeed(project.workspaceRoot),
        }),
      ),
    );

  const memoryDir = (root: string) => path.join(root, CIRCE_DIR, MEMORY_DIR);
  const retiredDir = (root: string) => path.join(memoryDir(root), RETIRED_DIR);

  // A missing memory directory is normal (memory is created lazily); any other
  // filesystem failure must surface rather than be reported as "no memory".
  const isMissing = (error: { readonly reason: { readonly _tag: string } }): boolean =>
    error.reason._tag === "NotFound";

  const readFolder = (projectId: string, dir: string, skipIndex: boolean) =>
    Effect.gen(function* () {
      const names = yield* fs.readDirectory(dir).pipe(
        Effect.catchIf(isMissing, () => Effect.succeed<ReadonlyArray<string>>([])),
        Effect.mapError((cause) => storeError(projectId, "read the memory directory", cause)),
      );
      const entries: Array<CirceMemoryEntry> = [];
      for (const name of names) {
        if (!name.endsWith(".md") || (skipIndex && name === INDEX_FILE)) continue;
        const text = yield* fs.readFileString(path.join(dir, name)).pipe(
          Effect.catchIf(isMissing, () => Effect.succeed("")),
          Effect.mapError((cause) => storeError(projectId, "read a memory entry", cause)),
        );
        const entry = parseMemoryFile(text);
        if (entry !== null) entries.push(entry);
      }
      return entries;
    });

  const readEntries = (projectId: string, root: string) =>
    readFolder(projectId, memoryDir(root), true).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.projectId === projectId)),
    );

  const writeIndex = (projectId: string, root: string, entries: ReadonlyArray<CirceMemoryEntry>) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const block = renderMemoryIndex(
        buildMemoryIndex(
          entries.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            source: entry.source,
            title: entry.title,
            body: entry.body,
            tags: entry.tags,
            status: entry.status,
            updatedAtMs: DateTime.toEpochMillis(entry.updatedAt),
            expiresAtMs:
              entry.expiresAt === undefined || entry.expiresAt === null
                ? null
                : DateTime.toEpochMillis(entry.expiresAt),
          })),
          { nowMs: DateTime.toEpochMillis(now) },
        ),
      );
      yield* fs
        .makeDirectory(memoryDir(root), { recursive: true })
        .pipe(
          Effect.mapError((cause) => storeError(projectId, "create the memory directory", cause)),
        );
      yield* fs
        .writeFileString(path.join(memoryDir(root), INDEX_FILE), block)
        .pipe(Effect.mapError((cause) => storeError(projectId, "write the memory index", cause)));
    });

  const list: CirceProjectMemoryShape["list"] = (projectId) =>
    Effect.gen(function* () {
      const root = yield* workspaceRoot(projectId);
      const entries = yield* readEntries(projectId, root);
      return entries.sort(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      );
    });

  const get: CirceProjectMemoryShape["get"] = (projectId, entryId) =>
    Effect.gen(function* () {
      const root = yield* workspaceRoot(projectId);
      const active = yield* readEntries(projectId, root);
      const found = active.find((entry) => entry.id === entryId);
      if (found !== undefined) return found;
      const retired = yield* readFolder(projectId, retiredDir(root), false);
      return retired.find((entry) => entry.id === entryId && entry.projectId === projectId) ?? null;
    });

  const index: CirceProjectMemoryShape["index"] = Effect.fn("CirceProjectMemory.index")(
    function* (projectId) {
      const now = yield* DateTime.now;
      const entries = yield* list(projectId);
      const views: ReadonlyArray<CirceMemoryView> = entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        source: entry.source,
        title: entry.title,
        body: entry.body,
        tags: entry.tags,
        status: entry.status,
        updatedAtMs: DateTime.toEpochMillis(entry.updatedAt),
        expiresAtMs:
          entry.expiresAt === undefined || entry.expiresAt === null
            ? null
            : DateTime.toEpochMillis(entry.expiresAt),
      }));
      const built = buildMemoryIndex(views, { nowMs: DateTime.toEpochMillis(now) });
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const result: CirceMemoryIndex = {
        projectId,
        entries: built.entries.map((item) => ({
          id: item.id,
          kind: item.kind,
          source: item.source,
          title: item.title,
          tags: item.tags,
          tokens: item.tokens,
          updatedAt: byId.get(item.id)?.updatedAt ?? now,
        })),
        totalTokens: built.totalTokens,
      };
      return result;
    },
  );

  const remember: CirceProjectMemoryShape["remember"] = Effect.fn("CirceProjectMemory.remember")(
    function* (input: CirceMemoryUpsertInput) {
      const root = yield* workspaceRoot(input.projectId);
      const now = yield* DateTime.now;
      const titleKey = normalizeTitle(input.title);
      const entries = yield* readEntries(input.projectId, root);
      const existing = entries.find(
        (entry) =>
          entry.kind === input.kind &&
          entry.status === "active" &&
          normalizeTitle(entry.title) === titleKey,
      );
      const corroborationCount = existing === undefined ? 0 : existing.corroborationCount + 1;
      if (
        input.kind === "fact" &&
        !memoryMayBeFact({
          source: input.source,
          corroborationCount,
          confirmed: input.confirmed === true,
        })
      ) {
        return yield* Effect.fail(
          new CirceMemoryPromotionError({ projectId: input.projectId, title: input.title }),
        );
      }
      const id = existing?.id ?? `mem_${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      const entry: CirceMemoryEntry = {
        id,
        projectId: input.projectId,
        kind: input.kind,
        source: input.source,
        title: input.title,
        body: input.body,
        tags: input.tags === undefined ? [] : [...input.tags],
        corroborationCount,
        status: "active",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        expiresAt: input.kind === "fact" ? DateTime.add(now, { days: FACT_TTL_DAYS }) : null,
      };
      yield* fs
        .makeDirectory(memoryDir(root), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            storeError(input.projectId, "create the memory directory", cause),
          ),
        );
      yield* fs
        .writeFileString(path.join(memoryDir(root), `${id}.md`), renderMemoryFile(entry))
        .pipe(
          Effect.mapError((cause) => storeError(input.projectId, "write the memory entry", cause)),
        );
      yield* writeIndex(
        input.projectId,
        root,
        entries.filter((candidate) => candidate.id !== id).concat(entry),
      );
      return entry;
    },
  );

  const forget: CirceProjectMemoryShape["forget"] = Effect.fn("CirceProjectMemory.forget")(
    function* (input) {
      const root = yield* workspaceRoot(input.projectId);
      const entries = yield* readEntries(input.projectId, root);
      const current = entries.find((entry) => entry.id === input.entryId);
      if (current === undefined) return { forgotten: false };
      const retired: CirceMemoryEntry = {
        ...current,
        status: "retired",
        updatedAt: yield* DateTime.now,
      };
      yield* fs
        .makeDirectory(retiredDir(root), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            storeError(input.projectId, "create the retired directory", cause),
          ),
        );
      yield* fs
        .writeFileString(path.join(retiredDir(root), `${retired.id}.md`), renderMemoryFile(retired))
        .pipe(
          Effect.mapError((cause) => storeError(input.projectId, "retire the memory entry", cause)),
        );
      yield* fs.remove(path.join(memoryDir(root), `${retired.id}.md`)).pipe(
        Effect.catchIf(isMissing, () => Effect.void),
        Effect.mapError((cause) =>
          storeError(input.projectId, "remove the retired memory entry", cause),
        ),
      );
      yield* writeIndex(
        input.projectId,
        root,
        entries.filter((entry) => entry.id !== input.entryId),
      );
      return { forgotten: true };
    },
  );

  return CirceProjectMemory.of({ remember, list, get, index, forget });
});

export const CirceProjectMemoryLive = Layer.effect(CirceProjectMemory, make);
