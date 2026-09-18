import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ForeignDatabaseError, migrationManifest, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

/**
 * IDs 41-58 shipped on the Circe line and are never renumbered. Upstream
 * migrations that landed after the fork point (upstream 044-053) are
 * re-registered above 58 so every migration applies exactly once.
 */
const EXPECTED_MANIFEST: ReadonlyArray<readonly [number, string]> = [
  [41, "CirceTaskDesks"],
  [42, "CirceTaskDeskAttention"],
  [43, "CirceTaskDeskClarification"],
  [44, "CirceProjectClarification"],
  [45, "CirceProjectAliases"],
  [46, "CirceReportOutbox"],
  [47, "AuthSessionClientConnection"],
  [48, "ProjectionThreadLinkedPullRequest"],
  [49, "ProjectionThreadsUnsettledAt"],
  [50, "CirceWorkStartedCandidates"],
  [51, "CirceFollowUpQueue"],
  [52, "CirceProjectAliasCurrentState"],
  [53, "CirceTaskDeskCurrentState"],
  [54, "CircePresentation"],
  [55, "CirceFollowUpQueueIdentity"],
  [56, "CirceTaskRefIdentity"],
  [57, "ProviderResponseFailureReasons"],
  [58, "CircePushRegistrations"],
  [59, "ClearAutomaticProjectModelDefaults"],
  [60, "ProjectionProjectsAutoPull"],
  [61, "RepairAutomaticSettlementTimestamps"],
  [62, "ProjectionProjectIcon"],
  [63, "ProjectionThreadBranchPullRequest"],
  [64, "ProjectionThreadsActiveOrderKey"],
  [65, "ProjectionThreadPullRequests"],
  [66, "CirceLiveVoiceSessions"],
  [67, "ProjectionThreadMessageContext"],
  [68, "ProjectionThreadTitleState"],
  [69, "OrchestrationV2"],
];

layer("MigrationRemap", (it) => {
  it.effect("registers every migration exactly once, in upgrade order", () =>
    Effect.gen(function* () {
      const ids = migrationManifest.map(([id]) => id as number);
      const names = migrationManifest.map(([, name]) => name as string);
      // Contiguous 1..69: no gaps, no duplicates, no renumbered slots.
      assert.deepEqual(
        ids,
        Array.from({ length: 69 }, (_, index) => index + 1),
      );
      assert.equal(new Set(names).size, names.length);
      for (const [id, name] of EXPECTED_MANIFEST) {
        assert.equal(names[id - 1], name, `migration ${id} must keep its shipped slot`);
      }
    }),
  );

  it.effect("upgrades a shipped 1-58 database by applying only 59-69", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const first = yield* runMigrations({ toMigrationInclusive: 58 });
      assert.equal(first.length, 58);

      const second = yield* runMigrations();
      assert.deepEqual(
        second.map(([id]) => Number(id)),
        [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69],
      );

      // The shifted 47/48/49 rows keep the names databases recorded before
      // the rebase, so the migrator never double-applies their DDL.
      const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.equal(recorded.length, 69);
      assert.deepEqual(
        recorded.slice(46, 49).map((row) => [Number(row.migration_id), row.name]),
        [
          [47, "AuthSessionClientConnection"],
          [48, "ProjectionThreadLinkedPullRequest"],
          [49, "ProjectionThreadsUnsettledAt"],
        ],
      );
      assert.deepEqual(
        recorded.slice(58).map((row) => [Number(row.migration_id), row.name]),
        [
          [59, "ClearAutomaticProjectModelDefaults"],
          [60, "ProjectionProjectsAutoPull"],
          [61, "RepairAutomaticSettlementTimestamps"],
          [62, "ProjectionProjectIcon"],
          [63, "ProjectionThreadBranchPullRequest"],
          [64, "ProjectionThreadsActiveOrderKey"],
          [65, "ProjectionThreadPullRequests"],
          [66, "CirceLiveVoiceSessions"],
          [67, "ProjectionThreadMessageContext"],
          [68, "ProjectionThreadTitleState"],
          [69, "OrchestrationV2"],
        ],
      );

      // A third run is a no-op: nothing re-applies.
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );

  it.effect("refuses a database whose recorded history belongs to another product", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE effect_sql_migrations (
          migration_id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `;
      // Upstream records a different migration under Circe's shipped id 41.
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'ThreadSummaryTimeline')
      `;

      const result = yield* runMigrations().pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        const defect = Cause.dieOption(result.cause);
        assert.isTrue(Option.isSome(defect));
        if (Option.isSome(defect)) {
          assert.instanceOf(defect.value, ForeignDatabaseError);
          assert.strictEqual(defect.value.reason, "history_mismatch");
        }
      }
    }),
  );
});
