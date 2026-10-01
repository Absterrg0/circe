/**
 * Demo 3: turning an agent's written report into something worth hearing.
 *
 * A coding agent finishes with Markdown, code fences, and file paths. Reading
 * that aloud is useless. Circe keeps the full report in the task and speaks a
 * bounded summary: whole sentences first, code replaced by one plain line.
 *
 * Run: node demos/03-spoken-report.ts
 */
import { selectSpokenSummary } from "../packages/circe-core/src/spokenSummary.ts";

const report = [
  "## Fixed the login redirect",
  "",
  "The callback handler dropped the `next` parameter when the session cookie was already set.",
  "I now carry it through the redirect and added a test for the signed-in case.",
  "",
  "```ts",
  'const next = url.searchParams.get("next") ?? "/";',
  "return redirect(sanitizeNext(next));",
  "```",
  "",
  "**Checks:** 14 tests pass, typecheck clean. The change is on branch `fix/login-redirect` and",
  "is ready for review. I did not touch the OAuth provider configuration, and the staging",
  "environment still needs the new cookie domain before this can be verified end to end.",
].join("\n");

console.log("The agent wrote:\n");
console.log(report);
console.log("\nCirce says, with a 320-character budget:\n");
console.log(selectSpokenSummary(report, 320));
console.log("\nCirce says, with a 200-character budget:\n");
console.log(selectSpokenSummary(report, 200));
