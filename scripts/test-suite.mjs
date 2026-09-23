import { readdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suite = process.argv[2] ?? "all";
const roots = suite === "company"
  ? [
    "server/company", "shared/company", "client/src/features/company",
    "server/accounting", "shared/accounting", "server/integrations/quickbooks", "server/jobs", "client/src/features/accounting",
    "server/projects", "shared/projects", "client/src/features/projects",
    "server/investors", "shared/investors", "client/src/features/investors",
    "server/company-documents", "shared/company-documents", "client/src/features/company-documents",
    "server/intake", "shared/intake", "server/time", "shared/time", "client/src/features/time",
    "server/reporting", "shared/reporting", "client/src/features/reporting",
    "server/work-orders", "shared/work-orders", "client/src/features/work-orders",
    // lane-c-review
    "server/review-cases", "shared/review-cases", "client/src/features/review-cases", "client/src/features/intake",
    "server/rent-ops/domain/review-detector.test.ts",
    "scripts/company/desktop-config.test.ts",
  ]
  : suite === "all"
    ? ["server", "shared", "client/src/features", "scripts", "client/src/components/account-entry.test.ts"]
    : null;
if (!roots) throw new Error("Unknown test suite; choose company or all");
const tests = [];
function discover(path) {
  if (!existsSync(path)) return;
  if (/\.test\.tsx?$/.test(path)) { tests.push(path); return; }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory() && !["node_modules", "dist", "fixtures"].includes(entry.name)) discover(join(path, entry.name));
    else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) tests.push(join(path, entry.name));
  }
}
for (const path of roots) discover(resolve(root, path));
if (!tests.length) throw new Error("No tests discovered; refusing an empty pass");
const env = { ...process.env, NODE_ENV: "test" };
// Tests use synthetic repositories/PGlite. Never inherit live database or
// service credentials into the default test runner.
for (const key of Object.keys(env)) {
  if (/(?:DATABASE_URL|API_KEY|TOKEN|SECRET|PRIVATE_KEY|ENCRYPTION_KEY)$/.test(key)) delete env[key];
}
const concurrency = Number(process.env.ROPS_TEST_CONCURRENCY ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("ROPS_TEST_CONCURRENCY must be an integer from 1 to 8");
const result = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")), "--no-cache", "--test", `--test-concurrency=${concurrency}`, ...tests.sort()], {
  cwd: root, env, stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
