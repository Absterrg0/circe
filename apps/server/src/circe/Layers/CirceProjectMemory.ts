import type { CirceMemoryEntry, CirceMemoryIndex, CirceMemoryUpsertInput } from "@circe/contracts";
import { buildMemoryIndex, memoryMayBeFact, type CirceMemoryView } from "@circe/core/projectMemory";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  CirceMemoryPromotionError,
  CirceProjectMemory,
  type CirceProjectMemoryShape,
} from "../Services/CirceProjectMemory.ts";

/**
 * In-process project memory adapter. The interface is the contract; the durable
 * event-sourced projection that survives restart is the next backing. Upsert
 * dedupes by kind plus normalized title, so a repeated claim corroborates the
 * existing entry instead of duplicating it, and a fact is promoted only when
 * policy allows it.
 */
const FACT_TTL_DAYS = 90;

const normalizeTitle = (title: string): string => title.trim().toLowerCase().replace(/\s+/gu, " ");

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const store = yield* Ref.make<ReadonlyMap<string, CirceMemoryEntry>>(new Map());

  const remember: CirceProjectMemoryShape["remember"] = Effect.fn("CirceProjectMemory.remember")(
    function* (input: CirceMemoryUpsertInput) {
      const now = yield* DateTime.now;
      const current = yield* Ref.get(store);
      const wanted = normalizeTitle(input.title);
      const existing = [...current.values()].find(
        (entry) =>
          entry.projectId === input.projectId &&
          entry.kind === input.kind &&
          entry.status === "active" &&
          normalizeTitle(entry.title) === wanted,
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
      yield* Ref.update(store, (map) => {
        const next = new Map(map);
        next.set(id, entry);
        return next;
      });
      return entry;
    },
  );

  const list: CirceProjectMemoryShape["list"] = (projectId) =>
    Ref.get(store).pipe(
      Effect.map((map) =>
        [...map.values()]
          .filter((entry) => entry.projectId === projectId)
          .sort(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
          ),
      ),
    );

  const get: CirceProjectMemoryShape["get"] = (projectId, entryId) =>
    Ref.get(store).pipe(
      Effect.map((map) => {
        const entry = map.get(entryId);
        return entry !== undefined && entry.projectId === projectId ? entry : null;
      }),
    );

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

  const forget: CirceProjectMemoryShape["forget"] = Effect.fn("CirceProjectMemory.forget")(
    function* (input) {
      const current = yield* Ref.get(store);
      const entry = current.get(input.entryId);
      if (entry === undefined || entry.projectId !== input.projectId) {
        return { forgotten: false };
      }
      const retired: CirceMemoryEntry = {
        ...entry,
        status: "retired",
        updatedAt: yield* DateTime.now,
      };
      yield* Ref.update(store, (map) => {
        const next = new Map(map);
        next.set(entry.id, retired);
        return next;
      });
      return { forgotten: true };
    },
  );

  return CirceProjectMemory.of({ remember, list, get, index, forget });
});

export const CirceProjectMemoryLive = Layer.effect(CirceProjectMemory, make);
