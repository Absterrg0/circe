import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable route for live voice leases.
 *
 * Migration 066 stored only local-key sessions: cloud sessions were assumed to
 * be owned by the relay reservation. But the relay only knows the session id
 * the node sent it; after a node restart or app upgrade the new process no
 * longer knows that id and can never release the slot, so the account stays
 * wedged on "already has an active live conversation" until the relay expires
 * it on its own. Persisting relay session ids lets a fresh process release
 * its own orphaned slots on demand. Existing rows predate relay persistence
 * and were only ever written for local-key sessions, so they backfill local.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE circe_live_voice_sessions
    ADD COLUMN route TEXT NOT NULL DEFAULT 'local'
  `;
});
