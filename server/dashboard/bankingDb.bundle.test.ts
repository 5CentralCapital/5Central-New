import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const run = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("the ESM banking bundle loads its native driver through createRequire", async () => {
  const directory = await mkdtemp(join(tmpdir(), "r-ops-banking-bundle-"));
  try {
    // A tiny CommonJS stand-in lets this test exercise Node's native require
    // path without compiling or loading a platform-specific SQLite binary.
    const driverDirectory = join(directory, "node_modules", "better-sqlite3");
    await mkdir(driverDirectory, { recursive: true });
    await writeFile(join(driverDirectory, "package.json"), JSON.stringify({ type: "commonjs", main: "index.js" }));
    await writeFile(join(driverDirectory, "index.js"), `
      class FakeDatabase {
        constructor() {}
        pragma() {}
        exec() {}
        prepare() { return { all() { return []; }, run() {}, get() { return { c: 0 }; } }; }
        transaction(work) { return (...args) => work(...args); }
      }
      module.exports = FakeDatabase;
    `);

    const output = join(directory, "bankingDb.mjs");
    await build({
      entryPoints: [resolve(repositoryRoot, "server/dashboard/bankingDb.ts")],
      bundle: true,
      format: "esm",
      packages: "external",
      platform: "node",
      outfile: output,
      logLevel: "silent",
    });

    const bundle = await readFile(output, "utf8");
    assert.match(bundle, /createRequire\(import\.meta\.url\)/);
    assert.doesNotMatch(bundle, /Dynamic require of "better-sqlite3"/);

    const result = await run(process.execPath, [output], {
      cwd: directory,
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
    });
    const logs = `${result.stdout}\n${result.stderr}`;
    assert.match(logs, /\[banking\] SQLite banking database ready/);
    assert.doesNotMatch(logs, /banking features disabled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
