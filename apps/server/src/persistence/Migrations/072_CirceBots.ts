import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Grok Bot conversations as this node recorded them.
 *
 * The roster table keeps the last names the gateway reported, so a stored
 * conversation still has a name while the gateway is down. A user row holds
 * the one-time reply token while its reply URL is open; closing the URL clears
 * the token, which is what makes a late or repeated callback fail.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS circe_bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      last_seen_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS circe_bot_messages (
      message_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivery TEXT,
      error TEXT,
      reply_token TEXT UNIQUE,
      reply_deadline_at TEXT,
      in_reply_to TEXT,
      outcome TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_circe_bot_messages_bot
    ON circe_bot_messages(bot_id, created_at)
  `;
});
