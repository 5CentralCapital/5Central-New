import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { seedRentalDemo } from "../company/testing/seed-rental-demo";
import { CompanyCommandError } from "../company/commands/errors";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { reconciliationHash } from "../rent-ops/reconciliation/operator";
import { prepareVerifiedImportedDocument } from "../rent-ops/services/service";
import { createInMemoryObjectStore } from "../rent-ops/storage";
import { createReviewCasePort, reviewDetectionJobHandler, runReviewDetection, summarizeReviewCaseRows, mapReviewCaseRow, REVIEW_CASE_COLUMNS } from "./index";

const organizationId = SYNTHETIC_COMPANY.organizationId;
const web = attestTransport("web");

async function setup() {
  const fixture = await createSyntheticCompanyDatabase();
  await seedRentalDemo({ executor: fixture.executor, actorId: SYNTHETIC_COMPANY.actorId, actorRole: "owner" });
  const runtime = await createSyntheticRuntimeExecutor(fixture.db);
  const storage = createInMemoryObjectStore();
  const port = createReviewCasePort(runtime, { documentStorage: storage });
  const principalFor = (actorId: string, role: "admin" | "read_only_reviewer" = "admin", org = organizationId, connection: RentOpsQueryExecutor = runtime) =>
    loadAuthenticatedPrincipal(connection, { actorId, organizationId: org, role });
  const accessFor = async (actorId = SYNTHETIC_COMPANY.actorId, role: "admin" | "read_only_reviewer" = "admin", org = organizationId) => ({
    principal: await principalFor(actorId, role, org), transport: web,
    resolvePrincipal: (transaction: RentOpsQueryExecutor) => principalFor(actorId, role, org, transaction),
  });
  return { fixture, db: fixture.db, runtime, storage, port, principalFor, accessFor };
}

function envelope(payload: Record<string, unknown>, expectedRevision?: number, org = organizationId) {
  const operationId = randomUUID();
  return { operationId, idempotencyKey: `review-case-test:${operationId}`, scope: { organizationId: org }, ...(expectedRevision === undefined ? {} : { expectedRevision }), payload };
}

/** Imported rental accounts with no imported ledger: one missing import partition. */
async function asImporter(db: PGlite, work: () => Promise<void>): Promise<void> {
  await db.exec("SET ROLE rent_ops_staging_importer");
  try { await work(); } finally { await db.exec("RESET ROLE"); }
}

async function addImportedAccounts(db: PGlite, from: number, count: number): Promise<void> {
  await asImporter(db, async () => {
    for (let index = from; index < from + count; index += 1) {
      await db.query("INSERT INTO rent_ops_people(id,first_name,last_name,source_system,source_id) VALUES ($1,'Imported',$2,'rent_manager',$3)", [`imported-person-${index}`, `Resident ${index}`, `tenant:${9000 + index}`]);
    }
  });
}

async function removeImportedAccounts(db: PGlite): Promise<void> {
  await db.query("DELETE FROM rent_ops_people WHERE id LIKE 'imported-person-%'");
}

async function historyCase(db: PGlite) {
  const result = await db.query<Record<string, unknown>>(`SELECT ${REVIEW_CASE_COLUMNS} FROM company_review_cases c WHERE c.reason_code = 'history_incomplete'`);
  assert.equal(result.rows.length, 1);
  return mapReviewCaseRow(result.rows[0]!);
}

async function events(db: PGlite, caseId: string) {
  return (await db.query<{ event_kind: string; from_state: string | null; to_state: string; actor_id: string; case_revision: number }>(
    "SELECT event_kind, from_state, to_state, actor_id, case_revision FROM company_review_case_events WHERE case_id = $1 ORDER BY case_revision, occurred_at", [caseId])).rows;
}

async function expectCommandError(promise: Promise<unknown>, status: number, reason?: string | RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanyCommandError, `expected a company command error, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    if (typeof reason === "string") assert.equal(error.details.reason, reason, error.message);
    else if (reason) assert.match(String(error.details.reason), reason);
    return true;
  });
}

test("detection dedupes one import gap into one case, refreshes, updates, auto-verifies and reopens", async () => {
  const { fixture, db, runtime } = await setup();
  try {
    await addImportedAccounts(db, 0, 12);
    const first = await runReviewDetection(runtime, organizationId);
    assert.ok(first.opened >= 1);
    let current = await historyCase(db);
    assert.equal(current.affectedCount, 12, "one case, twelve affected records");
    assert.equal(current.scopeKey, "organization");
    assert.equal(current.state, "open");
    assert.equal(current.impactCents, null, "unknown impact is stored as null, not zero");
    assert.equal(current.recordRevision, 1);

    const replay = await runReviewDetection(runtime, organizationId);
    assert.equal(replay.opened, 0);
    assert.equal(replay.updated, 0);
    assert.equal(replay.refreshed, first.candidateCount, "unchanged causes only refresh last_detected_at");
    assert.equal((await historyCase(db)).recordRevision, 1, "a refresh does not bump the revision");

    await addImportedAccounts(db, 12, 1);
    const updated = await runReviewDetection(runtime, organizationId);
    assert.equal(updated.updated, 1);
    current = await historyCase(db);
    assert.equal(current.affectedCount, 13);
    assert.equal(current.recordRevision, 2);

    await removeImportedAccounts(db);
    const resolved = await runReviewDetection(runtime, organizationId);
    assert.ok(resolved.autoVerified >= 1);
    current = await historyCase(db);
    assert.equal(current.state, "verified");
    assert.ok(current.resolvedAt);

    await addImportedAccounts(db, 0, 2);
    const reopened = await runReviewDetection(runtime, organizationId);
    assert.equal(reopened.reopened, 1);
    current = await historyCase(db);
    assert.equal(current.state, "open");
    assert.equal(current.reopenedCount, 1);
    assert.equal(current.resolvedAt, null);
    assert.deepEqual((await events(db, current.id)).map(event => event.event_kind), ["detected", "refreshed", "auto_resolved", "reopened"]);

    const job = reviewDetectionJobHandler({ executor: runtime });
    const jobResult = await job({ organizationId, payload: {} });
    assert.equal(jobResult.summary.opened, 0, "the job topic handler is idempotent");
    await assert.rejects(job({ organizationId, payload: { organizationId: "10000000-0000-4000-8000-000000000009" } }), /organization_mismatch/);
  } finally { await fixture.close(); }
});

test("case commands enforce transitions, revisions, idempotent replay and record an actor event per write", async () => {
  const { fixture, db, runtime, port, accessFor } = await setup();
  try {
    await addImportedAccounts(db, 0, 3);
    await runReviewDetection(runtime, organizationId);
    const access = await accessFor();
    let current = await historyCase(db);

    await expectCommandError(port.execute("review_case.verify", envelope({ caseId: current.id }, current.recordRevision), access), 400, "review_case_transition_not_allowed");
    await expectCommandError(port.execute("review_case.apply", envelope({ caseId: current.id }, current.recordRevision), access), 400, "review_case_transition_not_allowed");
    await expectCommandError(port.execute("review_case.start_research", envelope({ caseId: current.id }), access), 400, "review_case_revision_required");

    const research = envelope({ caseId: current.id, note: "Checking the archive manifest" }, current.recordRevision);
    const receipt = await port.execute("review_case.start_research", research, access);
    const replay = await port.execute("review_case.start_research", research, access);
    assert.deepEqual(replay, receipt, "same envelope replays the original receipt");
    assert.equal(receipt.resultingRevisions[0]!.revision, 2);
    await expectCommandError(port.execute("review_case.block", envelope({ caseId: current.id, missingFact: "Page 4 of the archive" }, 1), access), 409, "revision_conflict");
    await expectCommandError(port.execute("review_case.start_research", { ...research, payload: { caseId: current.id } }, access), 409, "idempotency_key_conflict");

    await port.execute("review_case.block", envelope({ caseId: current.id, missingFact: "Rent Manager past-tenant partition export" }, 2), access);
    current = await historyCase(db);
    assert.equal(current.state, "blocked");
    assert.equal(current.blockedOn, "Rent Manager past-tenant partition export");
    await port.execute("review_case.add_evidence", envelope({ caseId: current.id, evidence: { kind: "email", reference: "PM email 2026-09-20", summary: "PM confirms the past partition was not exported", observedOn: "2026-09-20" } }), access);
    await port.execute("review_case.note", envelope({ caseId: current.id, note: "Requested the export" }), access);
    current = await historyCase(db);
    assert.equal(current.recordRevision, 5);
    assert.equal(current.evidence.filter(item => item.origin === "manual").length, 1);
    await port.execute("review_case.start_research", envelope({ caseId: current.id }, current.recordRevision), access);
    current = await historyCase(db);
    assert.equal(current.state, "researching");
    assert.equal(current.blockedOn, null, "leaving blocked clears the missing fact");
    const history = await events(db, current.id);
    assert.deepEqual(history.map(event => event.event_kind), ["detected", "transitioned", "transitioned", "note", "note", "transitioned"]);
    assert.ok(history.slice(1).every(event => event.actor_id === SYNTHETIC_COMPANY.actorId));
    await assert.rejects(db.query("UPDATE company_review_case_events SET actor_id = 'x' WHERE case_id = $1", [current.id]), /append_only/);
  } finally { await fixture.close(); }
});

test("read-only reviewers can read but not mutate; another company is denied", async () => {
  const { fixture, db, runtime, port, principalFor, accessFor } = await setup();
  try {
    await addImportedAccounts(db, 0, 2);
    await runReviewDetection(runtime, organizationId);
    const current = await historyCase(db);
    await db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ($1,$2,'reviewer-1','read_only_reviewer')", [randomUUID(), organizationId]);
    const reviewer = await principalFor("reviewer-1", "read_only_reviewer");
    const list = await port.list(reviewer, { scope: { organizationId } });
    assert.ok(list.items.some(item => item.id === current.id));
    await expectCommandError(port.execute("review_case.note", envelope({ caseId: current.id, note: "x" }), await accessFor("reviewer-1", "read_only_reviewer")), 403, "role");
    await expectCommandError(port.execute("review_case.detect", envelope({}), await accessFor("reviewer-1", "read_only_reviewer")), 403, "role");

    const otherOrganization = "10000000-0000-4000-8000-000000000002";
    await db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Other Company')", [otherOrganization]);
    await db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ($1,$2,'other-admin','admin')", [randomUUID(), otherOrganization]);
    await assert.rejects(principalFor("other-admin", "admin", organizationId), (error: unknown) => error instanceof CompanyCommandError && error.status === 403);
    const outsider = await accessFor("other-admin", "admin", otherOrganization);
    await assert.rejects(port.list(outsider.principal, { scope: { organizationId } }), (error: unknown) => error instanceof CompanyCommandError && error.status === 403);
    await expectCommandError(port.execute("review_case.note", envelope({ caseId: current.id, note: "cross-company" }), outsider), 403, "organization_scope");
    await expectCommandError(port.execute("review_case.note", envelope({ caseId: current.id, note: "cross-company" }, undefined, otherOrganization), outsider), 400, "review_case_not_found");
  } finally { await fixture.close(); }
});

test("financial fixes are routed to accounting and never applied; connection fixes cannot be applied", async () => {
  const { fixture, db, runtime, port, accessFor } = await setup();
  try {
    await addImportedAccounts(db, 0, 2);
    await runReviewDetection(runtime, organizationId);
    const access = await accessFor();
    let current = await historyCase(db);
    await port.execute("review_case.propose", envelope({ caseId: current.id, correction: { kind: "financial", summary: "Post the missing opening balances", route: "accounting.journal_entry", amountCents: null } }, current.recordRevision), access);
    current = await historyCase(db);
    assert.equal(current.state, "proposed");
    const receipt = await port.execute("review_case.apply", envelope({ caseId: current.id }, current.recordRevision), access);
    assert.equal(receipt.state, "queued");
    assert.equal(receipt.validationOutcomes[0]!.code, "review_case.apply.routed_to_accounting");
    current = await historyCase(db);
    assert.equal(current.state, "proposed", "the case stays proposed with a routing reason");
    assert.equal(current.proposedCorrection?.routing?.status, "routed_to_accounting");
    const outbox = await db.query<{ topic: string }>("SELECT topic FROM company_outbox WHERE organization_id = $1", [organizationId]);
    assert.deepEqual(outbox.rows.map(row => row.topic), ["review_case.financial_correction"]);
    await expectCommandError(port.execute("review_case.apply", envelope({ caseId: current.id }, current.recordRevision), access), 400, "review_case_already_routed");

    await port.execute("review_case.propose", envelope({ caseId: current.id, correction: { kind: "connection", summary: "Importer skipped a partition", action: "Rerun the past-tenant export" } }, current.recordRevision), access);
    current = await historyCase(db);
    await expectCommandError(port.execute("review_case.apply", envelope({ caseId: current.id }, current.recordRevision), access), 400, "review_case_apply_unsupported");
    assert.equal((await historyCase(db)).state, "proposed");
  } finally { await fixture.close(); }
});

test("operational fixes dry-run on propose, refuse stale sources, apply through the guarded writer and verify by readback", async () => {
  const { fixture, db, runtime, storage, port, accessFor } = await setup();
  try {
    await addImportedAccounts(db, 0, 2);
    await asImporter(db, async () => { await db.query("INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge,source_system,source_id) VALUES ('rm-unit-9','demo-property-a','9Z','exact','rent_manager','unit:9')"); });
    await runReviewDetection(runtime, organizationId);
    const access = await accessFor();

    // A verified company document is the evidence the guarded writer re-hashes.
    const bytes = Buffer.from("Synthetic move-out inspection for unit 9Z, 2026-09-01.");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const prepared = await prepareVerifiedImportedDocument(storage, {
      documentId: "company-document:evidence-9z", type: "other", fileName: "inspection.txt", mimeType: "application/octet-stream", bytes, sizeBytes: bytes.byteLength, checksumSha256: checksum,
      sourceBinaryBinding: { bindingId: "b-9z", importRunId: "r-9z", sourceSystem: "company_documents", sourceCollection: "uploads", sourceIdHash: checksum },
    });
    await db.query(`INSERT INTO company_documents (id, organization_id, kind, state, title, file_name, declared_content_type, size_bytes, checksum_sha256, backend, logical_key, immutable_generation, immutable_version, verified_at)
      VALUES ($1,$2,'other','verified','Inspection 9Z','inspection.txt','text/plain',$3,$4,$5,$6,$7,$8,$9)`,
    ["company-document:evidence-9z", organizationId, bytes.byteLength, checksum, prepared.binding.backend, prepared.binding.logicalKey, prepared.binding.immutableGeneration ?? null, prepared.binding.immutableVersion ?? null, prepared.binding.verifiedAt]);

    const unit = async () => (await new PostgresRentOpsRepository(runtime).getSnapshot()).units.find(row => row.id === "rm-unit-9")!;
    const operation = async () => ({ kind: "vacancy-confirm", targetId: "rm-unit-9", sourceId: "unit:9", expectedRevision: 1, beforeSha256: reconciliationHash(await unit()), vacancyConfirmedOn: "2026-09-01" });
    let current = await historyCase(db);
    await port.execute("review_case.propose", envelope({ caseId: current.id, correction: { kind: "operational", summary: "Confirm unit 9Z vacant from the inspection", operation: await operation(), evidenceDocumentId: "company-document:evidence-9z" } }, current.recordRevision), access);
    current = await historyCase(db);
    assert.equal(current.state, "proposed");
    assert.match(current.proposedCorrection?.preview?.planToken ?? "", /^[a-f0-9]{64}$/);
    assert.equal((await unit()).vacancyConfirmedOn ?? null, null, "propose is a dry run");

    // The unit changes after the proposal: apply refuses the stale source and changes nothing.
    await db.query("UPDATE rent_ops_units SET unit_number = '9Z-A' WHERE id = 'rm-unit-9'");
    await expectCommandError(port.execute("review_case.apply", envelope({ caseId: current.id }, current.recordRevision), access), 409, "review_case_source_stale");
    assert.equal((await historyCase(db)).state, "proposed");
    assert.equal((await unit()).vacancyConfirmedOn ?? null, null);

    await port.execute("review_case.propose", envelope({ caseId: current.id, correction: { kind: "operational", summary: "Confirm unit 9Z vacant from the inspection", operation: await operation(), evidenceDocumentId: "company-document:evidence-9z" } }, current.recordRevision), access);
    current = await historyCase(db);
    const applied = await port.execute("review_case.apply", envelope({ caseId: current.id }, current.recordRevision), access);
    assert.ok(applied.affectedRecordIds.includes("rm-unit-9"));
    current = await historyCase(db);
    assert.equal(current.state, "applied");
    assert.equal((await unit()).vacancyConfirmedOn, "2026-09-01");
    const ledger = await db.query<{ count: string | number }>("SELECT count(*) AS count FROM rent_ops_ledger_transactions WHERE id LIKE 'review%'");
    assert.equal(Number(ledger.rows[0]!.count), 0);

    // Readback: the cause is still detected, so verify refuses.
    await expectCommandError(port.execute("review_case.verify", envelope({ caseId: current.id }, current.recordRevision), access), 400, "review_case_cause_present");
    await removeImportedAccounts(db);
    await port.execute("review_case.verify", envelope({ caseId: current.id }, current.recordRevision), access);
    current = await historyCase(db);
    assert.equal(current.state, "verified");
    await port.execute("review_case.reopen", envelope({ caseId: current.id, reason: "New archive page found" }, current.recordRevision), access);
    current = await historyCase(db);
    assert.equal(current.state, "open");
    assert.equal(current.reopenedCount, 1);
    assert.deepEqual((await events(db, current.id)).map(event => event.event_kind), ["detected", "proposed", "proposed", "applied", "verified", "reopened"]);
  } finally { await fixture.close(); }
});

test("an applied case whose evidence changes is reopened by detection", async () => {
  const { fixture, db, runtime } = await setup();
  try {
    await addImportedAccounts(db, 0, 2);
    await runReviewDetection(runtime, organizationId);
    const current = await historyCase(db);
    // Simulate an applied fix directly (the guarded apply path is covered above).
    await db.query("UPDATE company_review_cases SET state='applied', resolved_at=now(), record_revision=record_revision+1 WHERE id=$1", [current.id]);
    const same = await runReviewDetection(runtime, organizationId);
    assert.equal(same.reopened, 0, "same fingerprint leaves an applied case awaiting verification");
    await addImportedAccounts(db, 2, 1);
    const changed = await runReviewDetection(runtime, organizationId);
    assert.equal(changed.reopened, 1);
    const reopened = await historyCase(db);
    assert.equal(reopened.state, "open");
    assert.equal(reopened.reopenedCount, 1);
    assert.equal(reopened.affectedCount, 3);
  } finally { await fixture.close(); }
});

test("list groups cases and affected records separately; inventory lists remaining cases with missing evidence", async () => {
  const { fixture, db, runtime, port, principalFor, accessFor } = await setup();
  try {
    await addImportedAccounts(db, 0, 5);
    await runReviewDetection(runtime, organizationId);
    const principal = await principalFor(SYNTHETIC_COMPANY.actorId);
    const list = await port.list(principal, { scope: { organizationId }, limit: 1 });
    assert.equal(list.items.length, 1);
    assert.ok(list.nextCursor);
    const all = await port.list(principal, { scope: { organizationId }, limit: 100 });
    assert.equal(all.totals.caseCount, all.items.length);
    assert.equal(all.totals.affectedCount, all.items.reduce((sum, item) => sum + item.affectedCount, 0));
    const history = all.groups.find(group => group.causeFamily === "history_coverage" && group.materiality === "high");
    assert.deepEqual(history && { caseCount: history.caseCount, affectedCount: history.affectedCount }, { caseCount: 1, affectedCount: 5 });
    const page2 = await port.list(principal, { scope: { organizationId }, limit: 1, cursor: list.nextCursor! });
    assert.notEqual(page2.items[0]?.id, list.items[0]!.id);
    const filtered = await port.list(principal, { scope: { organizationId }, reasonCodes: ["history_incomplete"] });
    assert.equal(filtered.items.length, 1);
    assert.equal(filtered.items[0]!.shortLabel, "History incomplete");
    assert.equal(filtered.items[0]!.impactCents, null);

    const detail = await port.get(principal, { scope: { organizationId }, caseId: filtered.items[0]!.id });
    assert.equal(detail.affectedRecords.length, 5);
    assert.ok(detail.allowedCommands.includes("review_case.start_research"));
    assert.match(detail.requiredVerification, /coverage/i);
    await port.execute("review_case.block", envelope({ caseId: detail.id, missingFact: "Past-tenant partition export" }, detail.recordRevision), await accessFor());

    const inventory = await port.inventory(principal, { scope: { organizationId } });
    assert.equal(inventory.totals.activeCaseCount, all.items.length);
    const remaining = inventory.remaining.find(item => item.caseId === detail.id);
    assert.equal(remaining?.missingEvidence, "Past-tenant partition export");
    assert.equal(remaining?.nextAction, "Obtain: Past-tenant partition export");
    assert.ok(inventory.byReason.some(item => item.reasonCode === "history_incomplete" && item.affectedCount === 5));
    const summary = summarizeReviewCaseRows(organizationId, []);
    assert.equal(summary.totals.activeCaseCount, 0);
  } finally { await fixture.close(); }
});
