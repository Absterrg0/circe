import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@circe/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("074_CirceLiveVoiceRelayRoute", (it) => {
  it.effect("backfills local for pre-relay rows and round-trips relay rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`
        INSERT INTO circe_live_voice_sessions
          (session_id, environment_id, created_at, deadline_at)
        VALUES ('live_1', 'node-1', 1000, 2000)
      `;
      yield* runMigrations({ toMigrationInclusive: 74 });
      yield* sql`
        INSERT INTO circe_live_voice_sessions
          (session_id, environment_id, created_at, deadline_at, route)
        VALUES ('cloud_1', 'node-1', 1000, 2000, 'relay')
      `;
      const rows = yield* sql<{
        readonly sessionId: string;
        readonly route: string;
      }>`
        SELECT session_id AS "sessionId", route
        FROM circe_live_voice_sessions
        ORDER BY session_id
      `;
      assert.deepStrictEqual(rows, [
        { sessionId: "cloud_1", route: "relay" },
        { sessionId: "live_1", route: "local" },
      ]);
    }),
  );
});
