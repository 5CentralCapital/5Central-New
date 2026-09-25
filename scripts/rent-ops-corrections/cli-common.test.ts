import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliGuardError, privateOutputDirectory } from "./cli-common";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const insideRepository = (error: unknown) => error instanceof CliGuardError && error.code === "output_directory_inside_repository";

test("private evidence directories must be outside the repository", async () => {
  const dotted = join(repositoryRoot, `..rops-private-${process.pid}`);
  try {
    await assert.rejects(privateOutputDirectory(repositoryRoot), insideRepository);
    await assert.rejects(privateOutputDirectory(join(repositoryRoot, "evidence")), insideRepository);
    // A folder whose name merely starts with ".." is still inside the checkout.
    await assert.rejects(privateOutputDirectory(dotted), insideRepository);
  } finally {
    await rm(dotted, { recursive: true, force: true });
  }
  const outside = await mkdtemp(join(tmpdir(), "rops-private-"));
  try {
    assert.equal(await privateOutputDirectory(join(outside, "plan")), join(outside, "plan"));
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
