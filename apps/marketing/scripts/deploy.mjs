// Builds the site and deploys the static output to Vercel production.
//
// The Vercel project is the one linked in apps/marketing/.vercel (run
// `vercel link` here once). Headers and redirects come from vercel.ts, so the
// static deploy and the config file cannot drift.
//
// Usage: node apps/marketing/scripts/deploy.mjs [--preview]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const marketingDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.dirname(NodePath.dirname(marketingDir));
const distDir = NodePath.join(marketingDir, "dist");
const preview = process.argv.includes("--preview");

const run = (command, args, options) => {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const linkPath = NodePath.join(marketingDir, ".vercel", "project.json");
if (!NodeFS.existsSync(linkPath)) {
  console.error("No Vercel project is linked. Run `vercel link` in apps/marketing first.");
  process.exit(1);
}
const link = JSON.parse(NodeFS.readFileSync(linkPath, "utf8"));

run("vp", ["run", "--filter", "@circe/marketing", "build"], { cwd: repoRoot });

const { config } = await import(NodePath.join(marketingDir, "vercel.ts"));
NodeFS.writeFileSync(
  NodePath.join(distDir, "vercel.json"),
  `${JSON.stringify({ headers: config.headers, redirects: config.redirects }, null, 2)}\n`,
);

run("vercel", ["deploy", distDir, "--yes", ...(preview ? [] : ["--prod"])], {
  env: { ...process.env, VERCEL_ORG_ID: link.orgId, VERCEL_PROJECT_ID: link.projectId },
});
