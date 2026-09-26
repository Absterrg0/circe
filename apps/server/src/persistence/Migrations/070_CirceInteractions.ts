import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable assistant interactions and device operations.
 *
 * An interaction owns the current goal, the pending question, and its
 * revision; the revision is the ordering authority that stops two devices
 * from consuming the same answer. An operation owns one accepted device
 * effect and is written before execution, so a lost response is resolved by
 * inspecting state instead of retrying a side effect. Request rows make a
 * replayed submission idempotent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS circe_interactions (
      interaction_id TEXT PRIMARY KEY,
      owner_environment_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      active INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_circe_interactions_active
    ON circe_interactions(owner_environment_id, active)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS circe_operations (
      operation_id TEXT PRIMARY KEY,
      owner_environment_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      status TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_circe_operations_interaction
    ON circe_operations(interaction_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS circe_interaction_requests (
      request_id TEXT PRIMARY KEY,
      interaction_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
