import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Link a submission's request row to the operation acceptance created for it.
 * Acceptance writes the operation, the request claim and the interaction
 * revision in one transaction; the link is what lets a retry during or after
 * a mission return the same operation instead of accepting another one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE circe_interaction_requests ADD COLUMN operation_id TEXT`;
});
