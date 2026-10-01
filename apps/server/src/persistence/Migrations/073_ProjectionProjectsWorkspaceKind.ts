import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Stores what a workspace is. Every existing row starts as a project; the
 * node adopts its chat space through an orchestration event on the next
 * startup, so the event log and this column agree.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "workspace_kind")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'project'
    `;
  }
});
