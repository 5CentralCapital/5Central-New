import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain ESM entry point without type declarations
import { entryPointFor } from "./start.mjs";

test("the shared start command defaults to the web server and selects the worker by role", () => {
  assert.deepEqual(entryPointFor({}), { role: "web", specifier: "../../dist/index.js" });
  assert.deepEqual(entryPointFor({ RENT_OPS_PROCESS_ROLE: " worker " }), { role: "worker", specifier: "../../dist/worker.js" });
  assert.throws(() => entryPointFor({ RENT_OPS_PROCESS_ROLE: "both" }), /must be "web" or "worker"/);
  assert.throws(() => entryPointFor({ RENT_OPS_PROCESS_ROLE: "__proto__" }), /must be "web" or "worker"/);
});

test("an unknown role exits before loading any bundle and does not echo the value", () => {
  const script = fileURLToPath(new URL("./start.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], { env: { ...process.env, RENT_OPS_PROCESS_ROLE: "secret-looking-value" }, encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr + result.stdout, /secret-looking-value/);
});
