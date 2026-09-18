import { and, count, eq, gte, lt } from "drizzle-orm";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as RelayDb from "../db.ts";
import { relayTypeSafeDecisions } from "../persistence/schema.ts";

/** Managed decisions one environment may run in the rolling usage window. */
export const DEFAULT_TYPESAFE_DECISION_LIMIT = 1_000;
/** The quota is a rolling window, not a calendar day, to avoid a timezone cliff. */
const TYPESAFE_USAGE_WINDOW_MILLIS = 24 * 60 * 60_000;

export class TypeSafeUsageLimitExceeded extends Schema.TaggedError<TypeSafeUsageLimitExceeded>()(
  "TypeSafeUsageLimitExceeded",
  { environmentId: Schema.String, limit: Schema.Number },
) {}

export class TypeSafeUsagePersistenceFailed extends Schema.TaggedError<TypeSafeUsagePersistenceFailed>()(
  "TypeSafeUsagePersistenceFailed",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Relay failed to ${this.operation} for the managed decision tier`;
  }
}

export interface TypeSafeUsageShape {
  /**
   * Counts this environment's decisions in the rolling window and records one
   * more. Fails when the environment is at its limit. Only identity and time
   * are written; the request and response bodies never reach this service.
   */
  readonly reserve: (input: {
    readonly environmentId: string;
  }) => Effect.Effect<void, TypeSafeUsageLimitExceeded | TypeSafeUsagePersistenceFailed>;
}

export class TypeSafeUsage extends Context.Service<TypeSafeUsage, TypeSafeUsageShape>()(
  "@circe/relay/decision/TypeSafeUsage",
) {}

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const persistence = (operation: string) => (cause: unknown) =>
    new TypeSafeUsagePersistenceFailed({ operation, cause });

  return TypeSafeUsage.of({
    reserve: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const windowStartIso = DateTime.formatIso(
          DateTime.add(now, { milliseconds: -TYPESAFE_USAGE_WINDOW_MILLIS }),
        );

        yield* db
          .delete(relayTypeSafeDecisions)
          .where(lt(relayTypeSafeDecisions.startedAt, windowStartIso))
          .pipe(Effect.mapError(persistence("expire-usage")));

        const usedRows = yield* db
          .select({ used: count() })
          .from(relayTypeSafeDecisions)
          .where(
            and(
              eq(relayTypeSafeDecisions.environmentId, input.environmentId),
              gte(relayTypeSafeDecisions.startedAt, windowStartIso),
            ),
          )
          .pipe(Effect.mapError(persistence("count-usage")));
        const used = usedRows[0]?.used ?? 0;
        if (used >= DEFAULT_TYPESAFE_DECISION_LIMIT) {
          return yield* new TypeSafeUsageLimitExceeded({
            environmentId: input.environmentId,
            limit: DEFAULT_TYPESAFE_DECISION_LIMIT,
          });
        }

        yield* db
          .insert(relayTypeSafeDecisions)
          .values({
            // @effect-diagnostics-next-line cryptoRandomUUIDInEffect:off
            decisionId: crypto.randomUUID(),
            environmentId: input.environmentId,
            startedAt: nowIso,
          })
          .pipe(Effect.mapError(persistence("record-usage")));
      }),
  });
});

export const layer = Layer.effect(TypeSafeUsage, make);
