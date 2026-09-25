import assert from "node:assert/strict";
import test from "node:test";
import * as productionSchema from "./production-schema";
import * as documentRelocation from "./document-relocation";

const env = { RENT_OPS_MIGRATION_DATABASE_URL: "postgres://owner@db.invalid/app" };
const cliUsage = (error: unknown) => (error as { code?: unknown }).code === "cli_usage";

test("a value flag given without its value never falls back to the default connection", async () => {
  let opened = 0;
  const open = async () => { opened += 1; throw new Error("must not connect"); };
  // `--url-env` followed by another flag: the operator forgot the variable name.
  await assert.rejects(productionSchema.runCommand(productionSchema.parseArgs(["inspect", "--url-env", "--through", "48"]), env, open), cliUsage);
  await assert.rejects(productionSchema.runCommand(productionSchema.parseArgs(["describe", "--url-env"]), env, open), cliUsage);
  await assert.rejects(documentRelocation.runCommand(documentRelocation.parseArgs(["inventory", "--url-env"]), env, {
    open,
    source: async () => { throw new Error("unused"); },
    writer: () => { throw new Error("unused"); },
    reader: () => { throw new Error("unused"); },
    log: () => undefined,
  }), cliUsage);
  assert.equal(opened, 0);
});
