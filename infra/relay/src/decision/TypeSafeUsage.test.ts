import { describe, expect, it } from "@effect/vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "../db.ts";
import {
  DEFAULT_TYPESAFE_DECISION_LIMIT,
  TypeSafeUsage,
  TypeSafeUsageLimitExceeded,
  layer as typeSafeUsageLayer,
} from "./TypeSafeUsage.ts";

interface UsageRow {
  readonly decisionId: string;
  readonly environmentId: string;
  readonly startedAt: string;
}

const dialect = new PgDialect();
const query = (sql: SQL) => dialect.sqlToQuery(sql);

/** Minimal fake of the drizzle surface TypeSafeUsage touches. */
function makeFakeDb(seed: ReadonlyArray<UsageRow> = []) {
  const rows = [...seed];
  const service = {
    delete: () => ({
      where: (sql: SQL) =>
        Effect.sync(() => {
          const cutoff = String(query(sql).params[0]);
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index];
            if (row && row.startedAt < cutoff) rows.splice(index, 1);
          }
        }),
    }),
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: (sql: SQL) =>
          Effect.sync(() => {
            if (!("used" in fields)) return [];
            const params = query(sql).params;
            const environmentId = String(params[0]);
            const windowStart = String(params[1]);
            return [
              {
                used: rows.filter(
                  (row) => row.environmentId === environmentId && row.startedAt >= windowStart,
                ).length,
              },
            ];
          }),
      }),
    }),
    insert: () => ({
      values: (value: UsageRow) =>
        Effect.sync(() => {
          rows.push(value);
        }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  return { service, rows };
}

const runReserve = (db: RelayDb.RelayDb["Service"], environmentId = "env-test") =>
  Effect.gen(function* () {
    const usage = yield* TypeSafeUsage;
    return yield* usage.reserve({ environmentId });
  }).pipe(
    Effect.provide(typeSafeUsageLayer.pipe(Layer.provide(Layer.succeed(RelayDb.RelayDb, db)))),
  );

describe("TypeSafeUsage", () => {
  it.live("records a decision under the limit", () =>
    Effect.gen(function* () {
      const { service, rows } = makeFakeDb();
      yield* runReserve(service);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.environmentId).toBe("env-test");
    }),
  );

  it.live("fails at the limit without recording another decision", () =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const seed = Array.from({ length: DEFAULT_TYPESAFE_DECISION_LIMIT }, (_value, index) => ({
        decisionId: `decision-${index}`,
        environmentId: "env-test",
        startedAt: nowIso,
      }));
      const { service, rows } = makeFakeDb(seed);
      const error = yield* runReserve(service).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TypeSafeUsageLimitExceeded);
      expect(rows).toHaveLength(DEFAULT_TYPESAFE_DECISION_LIMIT);
    }),
  );

  it.live("prunes rows older than the window before counting", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const stale = DateTime.formatIso(DateTime.add(now, { milliseconds: -25 * 60 * 60_000 }));
      const seed = Array.from({ length: DEFAULT_TYPESAFE_DECISION_LIMIT }, (_value, index) => ({
        decisionId: `stale-${index}`,
        environmentId: "env-test",
        startedAt: stale,
      }));
      const { service, rows } = makeFakeDb(seed);
      yield* runReserve(service);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.decisionId).not.toBe("stale-0");
    }),
  );

  it.live("counts per environment", () =>
    Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const seed = Array.from({ length: DEFAULT_TYPESAFE_DECISION_LIMIT }, (_value, index) => ({
        decisionId: `other-${index}`,
        environmentId: "other-env",
        startedAt: nowIso,
      }));
      const { service, rows } = makeFakeDb(seed);
      yield* runReserve(service, "env-test");
      expect(rows).toHaveLength(DEFAULT_TYPESAFE_DECISION_LIMIT + 1);
    }),
  );
});
