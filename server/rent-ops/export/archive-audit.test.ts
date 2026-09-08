import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditRestrictedExportArchive } from "./archive-audit";
import { createRestrictedArchive } from "./archive";
import { RentManagerExportCollector } from "./collector";
import type { CollectionDefinition, RentManagerTransport } from "./types";

const registry: readonly CollectionDefinition[] = [
  { name: "documents", path: "/Documents", idFields: ["DocumentID"], entityType: "document", outputKey: "documents", documentMode: "binary_descriptor", required: true },
];

function transport(record: Record<string, unknown>): RentManagerTransport {
  return async () => ({ status: 200, headers: { "x-total-results": "1" }, body: { Data: [record] } });
}

async function fixtureArchive(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "rent-ops-archive-audit-"));
  await chmod(parent, 0o700);
  const root = join(parent, "archive");
  await new RentManagerExportCollector({
    transport: transport({ DocumentID: 1, FileName: "synthetic.pdf", ContentType: "application/pdf" }),
    archive: await createRestrictedArchive(root),
    registry,
    sleep: async () => undefined,
    binaryFetcher: async () => new Uint8Array([1, 2, 3, 4]),
    runId: "archive-audit-synthetic",
  }).collect();
  return { parent, root };
}

test("independent archive audit verifies envelope, pages, private files, and document bytes", async () => {
  const fixture = await fixtureArchive();
  try {
    const report = await auditRestrictedExportArchive(fixture.root);
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.deepEqual(report.blockingReasons, []);
    assert.equal(report.pageFileCount, 1);
    assert.equal(report.binaryFileCount, 1);
    assert.equal(report.verifiedBinaryCount, 1);
    assert.equal(report.verifiedBinaryBytes, 4);
    assert.match(report.envelopeSha256 ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("independent archive audit rejects a credential-bearing page without returning its value", async () => {
  const fixture = await fixtureArchive();
  const protectedValue = "synthetic-credential-value";
  try {
    const checkpoint = JSON.parse(await readFile(join(fixture.root, "checkpoint.json"), "utf8")) as { collections: { documents: { pageFiles: string[] } } };
    const page = join(fixture.root, checkpoint.collections.documents.pageFiles[0]);
    const records = JSON.parse(await readFile(page, "utf8")) as Array<Record<string, unknown>>;
    records[0].nested = [{ accessToken: protectedValue }];
    await writeFile(page, JSON.stringify(records), { mode: 0o600 });
    await chmod(page, 0o600);
    const report = await auditRestrictedExportArchive(fixture.root);
    assert.equal(report.passed, false);
    assert.ok(report.blockingReasons.includes("credential_shaped_field_detected"));
    assert.equal(JSON.stringify(report).includes(protectedValue), false);
    assert.equal(JSON.stringify(report).includes("accessToken"), false);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("independent archive audit rejects changed document bytes", async () => {
  const fixture = await fixtureArchive();
  try {
    const envelope = JSON.parse(await readFile(join(fixture.root, "export-envelope.json"), "utf8")) as { documentBinaries: Array<{ archivePath: string }> };
    const binary = join(fixture.root, envelope.documentBinaries[0].archivePath);
    await writeFile(binary, new Uint8Array([9, 9, 9, 9]), { mode: 0o600 });
    await chmod(binary, 0o600);
    const report = await auditRestrictedExportArchive(fixture.root);
    assert.equal(report.passed, false);
    assert.ok(report.blockingReasons.includes("archive_binary_integrity_mismatch"));
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("independent archive audit never reflects malformed raw JSON in its error report", async () => {
  const fixture = await fixtureArchive();
  const protectedValue = "synthetic-private-value-that-must-not-appear";
  try {
    const envelope = join(fixture.root, "export-envelope.json");
    await writeFile(envelope, `{not-json:${protectedValue}}`, { mode: 0o600 });
    await chmod(envelope, 0o600);
    const report = await auditRestrictedExportArchive(fixture.root);
    assert.equal(report.passed, false);
    assert.ok(report.blockingReasons.includes("archive_audit_failed"));
    assert.equal(JSON.stringify(report).includes(protectedValue), false);
    assert.equal(JSON.stringify(report).includes(fixture.root), false);
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test("independent archive audit rejects unmanifested files", async () => {
  const fixture = await fixtureArchive();
  try {
    const unexpected = join(fixture.root, "unmanifested.txt");
    await writeFile(unexpected, "synthetic", { mode: 0o600 });
    await chmod(unexpected, 0o600);
    const report = await auditRestrictedExportArchive(fixture.root);
    assert.equal(report.passed, false);
    assert.ok(report.blockingReasons.includes("archive_unexpected_file"));
  } finally {
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
