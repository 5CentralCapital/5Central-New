import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { seedRentalDemo } from "../company/testing/seed-rental-demo";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { createInMemoryObjectStore } from "../rent-ops/storage";
import { runReviewDetection } from "../review-cases/detection";
import { createIntakePort } from "./port";
import { createCompanyDocumentsPort } from "../company-documents/port";

const organizationId = SYNTHETIC_COMPANY.organizationId;
const scope = { organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId };
const codex = attestTransport("codex_mcp", ["mra_ingestion"]);

function line(id: string, account: string, amount: string, postedOn = "2026-09-05") {
  return {
    sourceAccountId: account, providerTransactionId: id, postedOn, amount, category: "rent", payer: "tenant",
    transactionKind: "payment", direction: "inflow", tenantSourceId: `resident-${account}`, tenantName: `Synthetic ${account}`,
    evidence: [{ sourcePath: `packet.json#${id}` }],
  };
}

function packetBytes(lines: unknown[], revision = "1"): Uint8Array {
  const accounts = new Map<string, unknown[]>();
  for (const value of lines as { sourceAccountId: string }[]) accounts.set(value.sourceAccountId, [...(accounts.get(value.sourceAccountId) ?? []), value]);
  return new TextEncoder().encode(JSON.stringify({
    format: "mra.owner_packet.v1", packetRevision: revision, period: { from: "2026-09-01", through: "2026-09-30" },
    accounts: Array.from(accounts.entries()).map(([sourceAccountId, rows]) => ({ sourceAccountId, lines: rows })),
  }));
}

async function setup() {
  const fixture = await createSyntheticCompanyDatabase();
  await seedRentalDemo({ executor: fixture.executor, actorId: SYNTHETIC_COMPANY.actorId, actorRole: "owner" });
  // The demo's elapsed "future" tenancy stops the rent roll (detection would be incomplete); confirm it current.
  await fixture.db.query("UPDATE rent_ops_tenancies SET status = 'current', status_knowledge = 'manual' WHERE id = 'demo-tenancy-2'");
  // Manually confirmed tenancies whose links allow a recorded payment.
  await fixture.db.exec(`
    INSERT INTO rent_ops_people(id,first_name,last_name) VALUES ('mra-person-1','Synthetic','Payer One'),('mra-person-2','Synthetic','Payer Two');
    INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge) VALUES ('mra-unit-1','demo-property-a','M1','manual'),('mra-unit-2','demo-property-a','M2','manual');
    INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge,actual_move_in_on,actual_move_in_knowledge)
      VALUES ('mra-tenancy-1','demo-property-a','mra-unit-1','mra-person-1','current',NOW(),'manual','manual','manual','manual','2026-01-01','manual'),
             ('mra-tenancy-2','demo-property-a','mra-unit-2','mra-person-2','current',NOW(),'manual','manual','manual','manual','2026-02-01','manual');`);
  const runtime = await createSyntheticRuntimeExecutor(fixture.db);
  const storage = createInMemoryObjectStore();
  const intake = createIntakePort(runtime, { documentStorage: storage });
  const principalFor = (connection: RentOpsQueryExecutor = runtime) => loadAuthenticatedPrincipal(connection, { actorId: SYNTHETIC_COMPANY.actorId, organizationId, role: "admin" });
  const access = async (transport = codex) => ({ principal: await principalFor(), transport, resolvePrincipal: (tx: RentOpsQueryExecutor) => principalFor(tx) });
  return { fixture, db: fixture.db, runtime, storage, intake, principalFor, access };
}

function envelope(payload: Record<string, unknown>) {
  const operationId = randomUUID();
  return { operationId, idempotencyKey: `mra-test:${operationId}`, scope, payload };
}

async function commandError(promise: Promise<unknown>, status: number, reason?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanyCommandError, String(error));
    assert.equal(error.status, status, error.message);
    if (reason) assert.equal(error.details.reason, reason, error.message);
    return true;
  });
}

test("MRA mutation is Codex-only: the web transport is denied at every step", async () => {
  const { fixture, intake, access } = await setup();
  try {
    const bytes = packetBytes([line("tx-1", "acct-1", "100.00")]);
    const web = await access(attestTransport("web"));
    await commandError(intake.stage(envelope({ action: "stage", fileName: "packet.json", declaredContentType: "application/json" }), { bytes }, web), 403, "channel");
    const codexNoCapability = await access(attestTransport("codex_mcp"));
    await commandError(intake.stage(envelope({ action: "stage", fileName: "packet.json", declaredContentType: "application/json" }), { bytes }, codexNoCapability), 403, "capability");
    const staged = await intake.stage(envelope({ action: "stage", fileName: "packet.json", declaredContentType: "application/json" }), { bytes }, await access());
    const packetId = String(staged.affectedRecordIds[0]);
    await commandError(intake.execute("preview", envelope({ action: "preview", packetId }), web), 403, "channel");
  } finally { await fixture.close(); }
});

test("stage binds the bytes' checksum into the command: replay is harmless, different bytes conflict", async () => {
  const { fixture, db, intake, access } = await setup();
  try {
    const bytes = packetBytes([line("tx-1", "acct-1", "100.00")]);
    const stage = envelope({ action: "stage", fileName: "packet.json", declaredContentType: "application/json" });
    const first = await intake.stage(stage, { bytes }, await access());
    const replay = await intake.stage(stage, { bytes }, await access());
    assert.deepEqual(replay, first);
    await commandError(intake.stage(stage, { bytes: packetBytes([line("tx-9", "acct-1", "999.00")]) }, await access()), 409, "idempotency_key_conflict");
    await commandError(intake.stage(envelope({ action: "stage", fileName: "packet.json", declaredContentType: "application/json", checksumSha256: "0".repeat(64) }), { bytes }, await access()), 400, "source_checksum_mismatch");
    const count = await db.query<{ count: string | number }>("SELECT count(*) AS count FROM company_intake_packets");
    assert.equal(Number(count.rows[0]!.count), 1);
    // Grants are reloaded inside the stage transaction: a principal loaded before revocation is refused.
    const loaded = await access();
    await db.query("UPDATE company_access_grants SET revoked_at = now() WHERE actor_id = $1", [SYNTHETIC_COMPANY.actorId]);
    await commandError(intake.stage(envelope({ action: "stage", fileName: "other.json", declaredContentType: "application/json" }), { bytes: packetBytes([line("tx-2", "acct-1", "5.00")]) }, loaded), 403, "grant_missing");
  } finally { await fixture.close(); }
});

test("apply keeps held and failed groups, conserves control totals, resumes without replaying and feeds review cases", async () => {
  const { fixture, db, runtime, intake, principalFor, access } = await setup();
  try {
    const bytes = packetBytes([
      line("tx-a1", "acct-1", "600.00"), line("tx-a2", "acct-1", "150.00", "2026-09-06"),
      line("tx-b1", "acct-2", "700.00"),
      line("tx-c1", "acct-3", "825.50"),
    ]);
    const staged = await intake.stage(envelope({ action: "stage", fileName: "owner-sept.json", declaredContentType: "application/json" }), { bytes }, await access());
    const packetId = String(staged.affectedRecordIds[0]);
    let packet = await intake.get(await principalFor(), { scope, packetId });
    const key = (id: string) => packet.lines.find(row => row.providerTransactionId === id)!.sourceLineKey;
    await intake.execute("map", envelope({ action: "map", packetId, mappings: [
      { sourceLineKey: key("tx-a1"), outcome: "exact", localTargetKind: "tenant_account", localTargetId: "mra-tenancy-1" },
      { sourceLineKey: key("tx-a2"), outcome: "exact", localTargetKind: "tenant_account", localTargetId: "mra-tenancy-1" },
      { sourceLineKey: key("tx-b1"), outcome: "exact", localTargetKind: "tenant_account", localTargetId: "missing-tenancy" },
    ] }), await access());
    await intake.execute("preview", envelope({ action: "preview", packetId }), await access());
    packet = await intake.get(await principalFor(), { scope, packetId });
    assert.equal(packet.state, "held");
    assert.equal(packet.lines.find(row => row.providerTransactionId === "tx-c1")?.outcome, "held_missing_identity");

    const applyEnvelope = envelope({ action: "apply", packetId });
    const applied = await intake.execute("apply", applyEnvelope, await access());
    assert.match(applied.validationOutcomes[0]!.message, /2 lines applied, 1 failed, 1 held/, JSON.stringify(applied.validationOutcomes));
    packet = await intake.get(await principalFor(), { scope, packetId });
    assert.equal(packet.state, "partially_applied");
    assert.deepEqual(packet.lines.map(row => [row.providerTransactionId, row.outcome]).sort(), [["tx-a1", "applied"], ["tx-a2", "applied"], ["tx-b1", "apply_failed"], ["tx-c1", "held_missing_identity"]]);
    const totals = packet.reconciliation!.totals[0]!;
    assert.equal(totals.inputCents, "227550");
    assert.equal(totals.appliedCents, "75000");
    assert.equal(totals.heldCents, "82550");
    assert.equal(BigInt(totals.inputCents), BigInt(totals.matchedCents) + BigInt(totals.heldCents) + BigInt(totals.duplicateCents) + BigInt(totals.overlapCents) + BigInt(70000), "input = matched + held + duplicate + overlap + failed");
    const payments = async () => Number((await db.query<{ count: string | number }>("SELECT count(*) AS count FROM rent_ops_ledger_transactions WHERE id LIKE 'mra-payment:%'")).rows[0]!.count);
    assert.equal(await payments(), 2);

    const replay = await intake.execute("apply", applyEnvelope, await access());
    assert.deepEqual(replay, applied, "replaying the apply envelope is harmless");
    assert.equal(await payments(), 2);

    // Held intake identity feeds the review queue with a known impact.
    await runReviewDetection(runtime, organizationId);
    const cases = await db.query<{ reason_code: string; affected_count: number; impact_cents: string | null }>("SELECT reason_code, affected_count, impact_cents::text AS impact_cents FROM company_review_cases WHERE reason_code LIKE 'intake_%' ORDER BY reason_code");
    assert.deepEqual(cases.rows.map(row => [row.reason_code, row.affected_count, row.impact_cents]), [["intake_identity_missing", 1, "82550"], ["intake_line_unsupported", 1, "70000"]]);

    // Resume: fix the failed group and apply again; applied lines are not replayed.
    await intake.execute("map", envelope({ action: "map", packetId, mappings: [{ sourceLineKey: key("tx-b1"), outcome: "exact", localTargetKind: "tenant_account", localTargetId: "mra-tenancy-2" }] }), await access());
    await commandError(intake.execute("map", envelope({ action: "map", packetId, mappings: [{ sourceLineKey: key("tx-a1"), outcome: "exact", localTargetKind: "tenant_account", localTargetId: "mra-tenancy-2" }] }), await access()), 400, "applied_line_remap");
    await intake.execute("preview", envelope({ action: "preview", packetId }), await access());
    const resumed = await intake.execute("apply", envelope({ action: "apply", packetId }), await access());
    assert.match(resumed.validationOutcomes[0]!.message, /1 lines applied, 0 failed, 1 held/);
    assert.equal(await payments(), 3);
    packet = await intake.get(await principalFor(), { scope, packetId });
    assert.equal(packet.reconciliation!.appliedLineCount, 3);

    // A revised packet cannot re-apply or erase applied history.
    const revised = packetBytes([line("tx-a1", "acct-1", "650.00"), line("tx-d1", "acct-1", "25.00", "2026-09-07")], "2");
    const stagedRevision = await intake.stage(envelope({ action: "stage", fileName: "owner-sept-rev2.json", declaredContentType: "application/json" }), { bytes: revised }, await access());
    const revisionId = String(stagedRevision.affectedRecordIds[0]);
    let revision = await intake.get(await principalFor(), { scope, packetId: revisionId });
    await intake.execute("map", envelope({ action: "map", packetId: revisionId, mappings: revision.lines.map(row => ({ sourceLineKey: row.sourceLineKey, outcome: "exact", localTargetKind: "tenant_account", localTargetId: "mra-tenancy-1" })) }), await access());
    await intake.execute("preview", envelope({ action: "preview", packetId: revisionId }), await access());
    revision = await intake.get(await principalFor(), { scope, packetId: revisionId });
    assert.deepEqual(revision.lines.map(row => [row.providerTransactionId, row.outcome]).sort(), [["tx-a1", "overlap"], ["tx-d1", "matched"]]);
    await intake.execute("apply", envelope({ action: "apply", packetId: revisionId }), await access());
    assert.equal(await payments(), 4, "only the new line is applied");
    const original = await intake.get(await principalFor(), { scope, packetId });
    assert.equal(original.lines.filter(row => row.outcome === "applied").length, 3, "earlier applied lines are preserved");
    const listed = await intake.list(await principalFor(), { scope: { organizationId } });
    assert.equal(listed.items.length, 2);
    assert.ok(listed.items.every(item => !("candidate" in item)));
  } finally { await fixture.close(); }
});

test("a packet can be staged from an existing verified company document", async () => {
  const { fixture, runtime, storage, intake, principalFor, access } = await setup();
  try {
    const documents = createCompanyDocumentsPort(runtime, { documentStorage: storage });
    const principal = await principalFor();
    const input = { context: { organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId }, kind: "other" as const, title: "MRA owner packet September", tags: [], links: [] };
    const bytes = packetBytes([line("tx-doc-1", "acct-1", "42.00")]);
    const staged = await documents.prepareUpload(principal, input, { bytes, fileName: "owner-packet.json", declaredContentType: "application/json" });
    await documents.execute("company_document.create", { operationId: randomUUID(), idempotencyKey: `doc:${randomUUID()}`, scope, payload: { action: "create", stageId: staged.stageId, input } },
      { principal, transport: attestTransport("web"), resolvePrincipal: tx => principalFor(tx) });
    const receipt = await intake.stage(envelope({ action: "stage", fileName: "owner-packet.json", declaredContentType: "application/json" }), { documentId: staged.document.id }, await access());
    const packet = await intake.get(await principalFor(), { scope, packetId: String(receipt.affectedRecordIds[0]) });
    assert.equal(packet.lines.length, 1);
    assert.equal(packet.lines[0]!.amountCents, "4200");
    await commandError(intake.stage(envelope({ action: "stage", fileName: "x.json", declaredContentType: "application/json" }), { documentId: "company-document:missing" }, await access()), 400, "source_document_missing");
  } finally { await fixture.close(); }
});

async function stageMapPreview(intake: Awaited<ReturnType<typeof setup>>["intake"], access: Awaited<ReturnType<typeof setup>>["access"], principalFor: Awaited<ReturnType<typeof setup>>["principalFor"], bytes: Uint8Array, fileName: string) {
  const staged = await intake.stage(envelope({ action: "stage", fileName, declaredContentType: "application/json" }), { bytes }, await access());
  const packetId = String(staged.affectedRecordIds[0]);
  const packet = await intake.get(await principalFor(), { scope, packetId });
  await intake.execute("map", envelope({ action: "map", packetId, mappings: packet.lines.map(row => ({ sourceLineKey: row.sourceLineKey, outcome: "exact", localTargetKind: "tenant_account", localTargetId: "mra-tenancy-1" })) }), await access());
  await intake.execute("preview", envelope({ action: "preview", packetId }), await access());
  return packetId;
}

for (const order of ["original first", "revision first"] as const) {
  test(`a revised packet previewed before either applies never posts the same source line twice (${order})`, async () => {
    const { fixture, db, intake, principalFor, access } = await setup();
    try {
      const originalId = await stageMapPreview(intake, access, principalFor, packetBytes([line("tx-a1", "acct-1", "100.00")], "1"), "p1.json");
      const key = (await intake.get(await principalFor(), { scope, packetId: originalId })).lines[0]!.sourceLineKey;
      const revisedLine = { ...line("tx-a1", "acct-1", "100.00"), correctsSourceLineKey: key };
      const revisionId = await stageMapPreview(intake, access, principalFor, packetBytes([revisedLine], "2"), "p2.json");
      const previewed = await intake.get(await principalFor(), { scope, packetId: revisionId });
      assert.equal(previewed.lines[0]!.outcome, "corrected", "preview sees an unapplied earlier observation");
      const [first, second] = order === "original first" ? [originalId, revisionId] : [revisionId, originalId];
      await intake.execute("apply", envelope({ action: "apply", packetId: first }), await access());
      const secondReceipt = await intake.execute("apply", envelope({ action: "apply", packetId: second }), await access());
      assert.match(secondReceipt.validationOutcomes[0]!.message, /0 lines applied, 0 failed/);
      assert.ok(secondReceipt.validationOutcomes.some(outcome => outcome.code === "intake.line.overlap"));
      const rows = await db.query<{ id: string }>("SELECT id FROM rent_ops_ledger_transactions WHERE id LIKE 'mra-payment:%'");
      assert.equal(rows.rows.length, 1, "exactly one payment for the source line");
      const firstPacket = await intake.get(await principalFor(), { scope, packetId: first });
      const secondPacket = await intake.get(await principalFor(), { scope, packetId: second });
      assert.equal(firstPacket.lines[0]!.outcome, "applied");
      assert.equal(secondPacket.lines[0]!.outcome, "overlap");
      assert.equal(secondPacket.reconciliation!.appliedLineCount, 0);
      const applied = await db.query<{ count: string | number }>("SELECT count(*) AS count FROM company_intake_line_registry WHERE source_line_key = $1 AND outcome = 'applied'", [key]);
      assert.equal(Number(applied.rows[0]!.count), 1);
    } finally { await fixture.close(); }
  });
}

test("the MRA payment ID is stable per organization and source line, not per packet", async () => {
  const { mraPaymentId } = await import("./service");
  const a = mraPaymentId({ scope: { organizationId } } as never, { sourceLineKey: "line-1" });
  assert.equal(a, mraPaymentId({ scope: { organizationId } } as never, { sourceLineKey: "line-1" }));
  assert.notEqual(a, mraPaymentId({ scope: { organizationId: "00000000-0000-4000-8000-000000000999" } } as never, { sourceLineKey: "line-1" }));
});

test("the registry allows at most one applied observation of a source line per organization", async () => {
  const { fixture, db, intake, principalFor, access } = await setup();
  try {
    const first = await stageMapPreview(intake, access, principalFor, packetBytes([line("tx-z1", "acct-1", "10.00")], "1"), "z1.json");
    const second = await stageMapPreview(intake, access, principalFor, packetBytes([line("tx-z1", "acct-1", "10.00")], "2"), "z2.json");
    const key = (await intake.get(await principalFor(), { scope, packetId: first })).lines[0]!.sourceLineKey;
    await db.query("UPDATE company_intake_line_registry SET outcome = 'applied' WHERE packet_id = $1", [first]);
    await assert.rejects(db.query("UPDATE company_intake_line_registry SET outcome = 'applied' WHERE packet_id = $1 AND source_line_key = $2", [second, key]), /applied_once|unique/i);
  } finally { await fixture.close(); }
});

test("a revised packet re-observing a held line does not open a second intake case, and applied lines close it", async () => {
  const { fixture, db, runtime, intake, principalFor, access } = await setup();
  try {
    const stagePreview = async (bytes: Uint8Array, fileName: string) => {
      const staged = await intake.stage(envelope({ action: "stage", fileName, declaredContentType: "application/json" }), { bytes }, await access());
      const packetId = String(staged.affectedRecordIds[0]);
      await intake.execute("preview", envelope({ action: "preview", packetId }), await access());
      return packetId;
    };
    await stagePreview(packetBytes([line("tx-h1", "acct-9", "40.00")], "1"), "held-1.json");
    const revisionId = await stagePreview(packetBytes([line("tx-h1", "acct-9", "40.00"), line("tx-h2", "acct-9", "5.00")], "2"), "held-2.json");
    const intakeCases = async () => (await db.query<{ reason_code: string; affected_count: number; state: string }>("SELECT reason_code, affected_count, state FROM company_review_cases WHERE reason_code LIKE 'intake_%' ORDER BY reason_code, affected_count")).rows;
    await runReviewDetection(runtime, organizationId);
    assert.deepEqual((await intakeCases()).map(row => [row.reason_code, row.affected_count]), [["intake_identity_missing", 2]], "one case for the newest observation of each line");

    const revision = await intake.get(await principalFor(), { scope, packetId: revisionId });
    await intake.execute("map", envelope({ action: "map", packetId: revisionId, mappings: revision.lines.map(row => ({ sourceLineKey: row.sourceLineKey, outcome: "exact", localTargetKind: "tenant_account", localTargetId: "mra-tenancy-1" })) }), await access());
    await intake.execute("preview", envelope({ action: "preview", packetId: revisionId }), await access());
    await intake.execute("apply", envelope({ action: "apply", packetId: revisionId }), await access());
    await runReviewDetection(runtime, organizationId);
    assert.deepEqual((await intakeCases()).map(row => row.state), ["verified"], "the older packet's held copy of an applied line is not an open cause");
  } finally { await fixture.close(); }
});
