import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { CompanyCommandError } from "../company/commands/errors";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { createAccountingOperationsPort } from "./operations";
import { assertRentalPostingMethod, rentalPostingMethodFor } from "./posting-policy";

const ORG = SYNTHETIC_COMPANY.organizationId;
const ENTITY = SYNTHETIC_COMPANY.entityId;
const PROPERTY = SYNTHETIC_COMPANY.propertyId;
const UNIT = SYNTHETIC_COMPANY.unitId;

async function harness() {
  const synthetic = await createSyntheticCompanyDatabase();
  const raw = synthetic.executor;
  await raw.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ($1,$2,'reviewer-1','read_only_reviewer')", [randomUUID(), ORG]);
  await raw.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role,legal_entity_id) VALUES ($1,$2,'finance-1','finance',$3)", [randomUUID(), ORG, ENTITY]);
  const executor = await createSyntheticRuntimeExecutor(synthetic.db);
  const operations = createAccountingOperationsPort(executor, { now: () => new Date("2026-09-23T12:00:00Z") });
  const access = async (actorId = "demo-admin", role: "admin" | "read_only_reviewer" | "finance" = "admin") => {
    const resolvePrincipal = (transaction: RentOpsQueryExecutor) => loadAuthenticatedPrincipal(transaction, { actorId, organizationId: ORG, role });
    return { principal: await resolvePrincipal(executor), resolvePrincipal, transport: attestTransport("web") };
  };
  return { synthetic, raw, executor, operations, access, close: () => synthetic.close() };
}

function envelope(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { operationId: randomUUID(), idempotencyKey: `test-${randomUUID()}`, scope: { organizationId: ORG, legalEntityId: ENTITY }, payload, ...extra };
}

async function rejects(work: Promise<unknown>, reason: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof CompanyCommandError, `expected a command error, got ${String(error)}`);
    assert.equal(error.details.reason, reason, error.message);
    return true;
  });
}

test("rental posting policy: one method per entity and period, overlap rejected, method switches need a bridge", async () => {
  const h = await harness();
  try {
    const admin = await h.access();
    const setBridge = envelope({ method: "summary_bridge", effectiveFrom: "2026-01-01", cutoffDate: "2026-01-01", reason: "PM statements summarized monthly" });
    const receipt = await h.operations.execute("accounting.rental_posting_policy.set", setBridge, admin);
    assert.equal(receipt.state, "saved_in_rops");
    assert.match(receipt.validationOutcomes[0]!.message, /Nothing was posted/);
    const replay = await h.operations.execute("accounting.rental_posting_policy.set", setBridge, admin);
    assert.deepEqual(replay, receipt, "an identical retry replays the receipt");
    await rejects(h.operations.execute("accounting.rental_posting_policy.set", envelope({ method: "not_posted", effectiveFrom: "2026-06-01", cutoffDate: "2026-06-01", reason: "overlap" }), admin), "rental_posting_policy_overlap");
    // The database trigger is the backstop for any writer that skips the command.
    await assert.rejects(h.raw.query(
      `INSERT INTO accounting_rental_posting_policies (id, organization_id, legal_entity_id, method, effective_from, cutoff_date, approved_by, reason)
       VALUES ($1,$2,$3,'not_posted','2026-03-01','2026-03-01','demo-admin','direct')`, [randomUUID(), ORG, ENTITY]), /overlap/);
    await assert.rejects(h.operations.execute("accounting.rental_posting_policy.set", envelope({ method: "native_receivables", effectiveFrom: "2027-01-01", cutoffDate: "2027-01-01", reason: "x" }), admin), /invoice email/);

    const policies = await h.operations.listPostingPolicies(admin.principal, { organizationId: ORG, legalEntityId: ENTITY });
    const current = policies.items[0]!;
    assert.equal(current.method, "summary_bridge");
    await rejects(h.operations.execute("accounting.rental_posting_policy.close", envelope({ policyId: current.id, effectiveUntil: "2026-10-01", reason: "switching" }, { expectedRevision: 9 }), admin), "revision_conflict");
    await h.operations.execute("accounting.rental_posting_policy.close", envelope({ policyId: current.id, effectiveUntil: "2026-10-01", reason: "switching to receivables" }, { expectedRevision: current.recordRevision }), admin);
    await rejects(h.operations.execute("accounting.rental_posting_policy.set", envelope({ method: "native_receivables", effectiveFrom: "2026-10-01", cutoffDate: "2026-10-01", invoiceDeliveryVerified: true, reason: "native" }), admin), "opening_balance_bridge_required");
    await h.operations.execute("accounting.rental_posting_policy.set", envelope({ method: "native_receivables", effectiveFrom: "2026-10-01", cutoffDate: "2026-10-15", invoiceDeliveryVerified: true, openingBalanceBridgeReference: "OB-2026-10", reason: "native" }), admin);

    assert.equal((await rentalPostingMethodFor(h.executor, { organizationId: ORG, legalEntityId: ENTITY, date: "2026-09-30" }))?.method, "summary_bridge");
    assert.equal((await rentalPostingMethodFor(h.executor, { organizationId: ORG, legalEntityId: ENTITY, date: "2026-10-01" }))?.method, "native_receivables");
    assert.equal(await rentalPostingMethodFor(h.executor, { organizationId: ORG, legalEntityId: ENTITY, date: "2025-12-31" }), null);
    await rejects(assertRentalPostingMethod(h.executor, { organizationId: ORG, legalEntityId: ENTITY, activityDate: "2025-12-31", method: "summary_bridge" }), "rental_posting_policy_missing");
    await rejects(assertRentalPostingMethod(h.executor, { organizationId: ORG, legalEntityId: ENTITY, activityDate: "2026-11-01", method: "summary_bridge" }), "rental_posting_method_conflict");
    await rejects(assertRentalPostingMethod(h.executor, { organizationId: ORG, legalEntityId: ENTITY, activityDate: "2026-10-05", method: "native_receivables" }), "rental_posting_before_cutoff");
    assert.equal((await assertRentalPostingMethod(h.executor, { organizationId: ORG, legalEntityId: ENTITY, activityDate: "2026-10-20", method: "native_receivables" })).method, "native_receivables");

    const reviewer = await h.access("reviewer-1", "read_only_reviewer");
    await rejects(h.operations.execute("accounting.rental_posting_policy.set", envelope({ method: "not_posted", effectiveFrom: "2030-01-01", cutoffDate: "2030-01-01", reason: "x" }), reviewer), "role");
    assert.equal((await h.operations.listPostingPolicies(reviewer.principal, { organizationId: ORG, legalEntityId: ENTITY })).items.length, 2, "reviewers can read");
    await rejects(h.operations.execute("accounting.rental_posting_policy.set", { ...envelope({ method: "not_posted", effectiveFrom: "2030-01-01", cutoffDate: "2030-01-01", reason: "x" }), scope: { organizationId: ORG } }, admin), "scope_level");
  } finally {
    await h.close();
  }
});

const pmStatement = (extra: Record<string, unknown> = {}) => ({
  propertyId: PROPERTY, managerName: "Synthetic Property Management", periodStart: "2026-08-01", periodEnd: "2026-08-31", currency: "USD",
  openingHeldCents: "0", grossCollectionsCents: "100000", pmFeesCents: "10000", pmExpensesCents: "0", otherDeductionsCents: "0",
  ownerRemittanceCents: "90000", closingHeldCents: "0",
  lines: [
    { kind: "rent_receipt", unitId: UNIT, description: "August rent", amountCents: "100000", occurredOn: "2026-08-03" },
    { kind: "pm_fee", description: "Management fee", amountCents: "10000" },
    { kind: "owner_remittance", description: "Owner draw", amountCents: "90000", occurredOn: "2026-08-31" },
  ],
  ...extra,
});

test("PM settlement gross-to-net keeps positive remittances draft without verified bank observations", async () => {
  const h = await harness();
  try {
    const admin = await h.access();
    const created = await h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement()), admin);
    const id = created.affectedRecordIds[0]!;
    assert.match(created.validationOutcomes[0]!.message, /verified bank-observation source is available/i);
    const detail = await h.operations.getPmSettlement(admin.principal, { scope: { organizationId: ORG } as never, settlementId: id });
    assert.equal(detail.grossToNet.collections.totalCents, "100000");
    assert.equal(detail.grossToNet.operatingCollectionsCents, "100000");
    assert.equal(detail.grossToNet.costs.totalCents, "10000");
    assert.equal(detail.grossToNet.remittedCents, "90000");
    assert.equal(detail.grossToNet.heldChangeCents, "0");
    assert.equal(JSON.stringify(detail).includes("190000"), false, "no measure adds remittance to collections");
    assert.deepEqual(detail.differences.map(item => [item.code, item.amountCents]), [["remittance_not_bank_settled", "90000"]]);
    assert.equal(detail.state, "draft");

    const headerBefore = await h.raw.query<Record<string, unknown>>(
      "SELECT state, record_revision, bank_observation_reference, bank_settled_on FROM accounting_pm_settlements WHERE id = $1", [id],
    );
    const lineHistoryBefore = await h.raw.query<{ settlement_revision: number; count: number }>(
      "SELECT settlement_revision, COUNT(*)::int AS count FROM accounting_pm_settlement_lines WHERE settlement_id = $1 GROUP BY settlement_revision ORDER BY settlement_revision", [id],
    );
    const auditBefore = await h.raw.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM company_command_receipts WHERE organization_id = $1", [ORG]);
    await assert.rejects(
      h.operations.execute("accounting.pm_settlement.reconcile", envelope({ settlementId: id, bankObservationReference: "Fabricated deposit reference", bankSettledOn: "2026-09-02" }, { expectedRevision: 1 }), admin),
      (error: unknown) => {
        assert.ok(error instanceof CompanyCommandError);
        assert.equal(error.details.reason, "pm_settlement_bank_verification_unavailable");
        assert.match(error.message, /bank verification.*unavailable/i);
        assert.match(error.message, /reference or date does not verify/i);
        return true;
      },
    );
    const headerAfter = await h.raw.query<Record<string, unknown>>(
      "SELECT state, record_revision, bank_observation_reference, bank_settled_on FROM accounting_pm_settlements WHERE id = $1", [id],
    );
    const lineHistoryAfter = await h.raw.query<{ settlement_revision: number; count: number }>(
      "SELECT settlement_revision, COUNT(*)::int AS count FROM accounting_pm_settlement_lines WHERE settlement_id = $1 GROUP BY settlement_revision ORDER BY settlement_revision", [id],
    );
    const auditAfter = await h.raw.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM company_command_receipts WHERE organization_id = $1", [ORG]);
    assert.deepEqual(headerAfter.rows, headerBefore.rows, "a fabricated reference changes neither the header nor revision");
    assert.deepEqual(lineHistoryAfter.rows, lineHistoryBefore.rows, "a rejected reconcile adds no line revision");
    assert.equal(auditAfter.rows[0]?.count, auditBefore.rows[0]?.count, "a rejected reconcile writes no command audit receipt");
    const after = await h.operations.getPmSettlement(admin.principal, { scope: { organizationId: ORG, legalEntityId: ENTITY } as never, settlementId: id });
    assert.equal(after.state, "draft");
    assert.equal(after.recordRevision, 1);
    assert.equal(after.bankObservationReference, null);
    assert.equal(after.bankSettledOn, null);
    assert.equal(after.grossToNet.collections.totalCents, "100000");
    assert.equal(after.grossToNet.costs.totalCents, "10000");
    assert.equal(after.grossToNet.remittedCents, "90000");
    assert.equal(after.lines.length, 3);
  } finally {
    await h.close();
  }
});

test("zero-remittance PM settlements reconcile without bank evidence and retain revision history", async () => {
  const h = await harness();
  try {
    const admin = await h.access();
    const statement = pmStatement({ ownerRemittanceCents: "0", closingHeldCents: "90000", lines: pmStatement().lines.slice(0, 2) });
    const created = await h.operations.execute("accounting.pm_settlement.create", envelope(statement), admin);
    const id = created.affectedRecordIds[0]!;
    const { propertyId: _ignored, ...content } = statement;

    const reconciled = await h.operations.execute("accounting.pm_settlement.reconcile", envelope({ settlementId: id }, { expectedRevision: 1 }), admin);
    assert.equal(reconciled.resultingRevisions[0]?.revision, 2);
    const afterReconcile = await h.operations.getPmSettlement(admin.principal, { scope: { organizationId: ORG } as never, settlementId: id });
    assert.equal(afterReconcile.state, "reconciled");
    assert.equal(afterReconcile.bankObservationReference, null);
    assert.equal(afterReconcile.bankSettledOn, null);
    assert.deepEqual(afterReconcile.differences, []);
    assert.equal(afterReconcile.grossToNet.collections.totalCents, "100000");
    assert.equal(afterReconcile.grossToNet.costs.totalCents, "10000");
    assert.equal(afterReconcile.grossToNet.remittedCents, "0");
    assert.equal(afterReconcile.grossToNet.heldChangeCents, "90000");
    assert.equal(afterReconcile.lines.length, 2, "the zero-remittance lines carry forward to revision 2");
    await rejects(h.operations.execute("accounting.pm_settlement.update", envelope({ settlementId: id, ...content }, { expectedRevision: 2 }), admin), "pm_settlement_reconciled_locked");

    await h.operations.execute("accounting.pm_settlement.exception.mark", envelope({ settlementId: id, reason: "Correcting statement detail" }, { expectedRevision: 2 }), admin);
    await rejects(h.operations.execute("accounting.pm_settlement.update", envelope({ settlementId: id, ...content }, { expectedRevision: 2 }), admin), "revision_conflict");
    const corrected = {
      ...content,
      pmFeesCents: "8000",
      ownerRemittanceCents: "92000",
      closingHeldCents: "0",
      lines: [content.lines[0], { kind: "pm_fee", description: "Management fee (8%)", amountCents: "8000" }, { kind: "owner_remittance", description: "Owner draw", amountCents: "92000" }],
    };
    await h.operations.execute("accounting.pm_settlement.update", envelope({ settlementId: id, ...corrected }, { expectedRevision: 3 }), admin);
    const historyBeforeClear = await h.raw.query<{ settlement_revision: number; count: number }>(
      "SELECT settlement_revision, COUNT(*)::int AS count FROM accounting_pm_settlement_lines WHERE settlement_id = $1 GROUP BY settlement_revision ORDER BY settlement_revision", [id],
    );
    assert.deepEqual(historyBeforeClear.rows.map(row => [row.settlement_revision, row.count]), [[1, 2], [2, 2], [3, 2], [4, 3]], "each line set remains attached to its revision");
    await h.operations.execute("accounting.pm_settlement.exception.clear", envelope({ settlementId: id }, { expectedRevision: 4 }), admin);
    const cleared = await h.operations.getPmSettlement(admin.principal, { scope: { organizationId: ORG } as never, settlementId: id });
    assert.equal(cleared.state, "draft");
    assert.equal(cleared.recordRevision, 5);
    assert.equal(cleared.grossToNet.costs.feesCents, "8000");
    assert.equal(cleared.grossToNet.remittedCents, "92000");
    const history = await h.raw.query<{ settlement_revision: number; count: number }>(
      "SELECT settlement_revision, COUNT(*)::int AS count FROM accounting_pm_settlement_lines WHERE settlement_id = $1 GROUP BY settlement_revision ORDER BY settlement_revision", [id],
    );
    assert.deepEqual(history.rows.map(row => [row.settlement_revision, row.count]), [[1, 2], [2, 2], [3, 2], [4, 3], [5, 3]], "exception and clear revisions retain their lines");
  } finally {
    await h.close();
  }
});

test("PM settlements refuse unbalanced lines, non-conserving headers, foreign references and duplicates", async () => {
  const h = await harness();
  try {
    const admin = await h.access();
    await rejects(h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement({ grossCollectionsCents: "110000", closingHeldCents: "10000" })), admin), "pm_settlement_lines_mismatch");
    await rejects(h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement({ closingHeldCents: "500" })), admin), "pm_settlement_not_conserved");
    await rejects(h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement({ lines: [...pmStatement().lines.slice(0, 2), { kind: "owner_remittance", unitId: "not-a-unit", description: "x", amountCents: "90000" }] })), admin), "pm_settlement_unit_property");
    await rejects(h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement({ currency: "CAD" })), admin), "pm_settlement_currency");
    await rejects(h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement({ periodStart: "2019-01-01", periodEnd: "2019-01-31" })), admin), "pm_settlement_property_entity");
    await h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement()), admin);
    await rejects(h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement()), admin), "pm_settlement_duplicate");
    // The header conservation check also lives in the database.
    await assert.rejects(h.raw.query(`UPDATE accounting_pm_settlements SET closing_held_cents = 1`), /check/i);
    await h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement({ periodStart: "2026-07-01", periodEnd: "2026-07-31" })), admin);
    const first = await h.operations.listPmSettlements(admin.principal, { organizationId: ORG, legalEntityId: ENTITY, limit: 1 });
    assert.equal(first.items[0]?.periodEnd, "2026-08-31");
    assert.equal(first.items[0]?.pmCostsCents, "10000");
    const second = await h.operations.listPmSettlements(admin.principal, { organizationId: ORG, legalEntityId: ENTITY, limit: 1, cursor: first.nextCursor! });
    assert.equal(second.items[0]?.periodEnd, "2026-07-31");
    assert.equal(second.nextCursor, null);
    const reviewer = await h.access("reviewer-1", "read_only_reviewer");
    await rejects(h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement({ periodStart: "2026-06-01", periodEnd: "2026-06-30" })), reviewer), "role");
  } finally {
    await h.close();
  }
});

async function seedLedger(raw: RentOpsQueryExecutor) {
  await raw.query("INSERT INTO rent_ops_people (id, first_name, last_name) VALUES ('person-1','Synthetic','Tenant')");
  await raw.query("INSERT INTO rent_ops_tenancies (id, property_id, unit_id, primary_person_id, status, created_at) VALUES ('tenancy-1',$1,$2,'person-1','current',now())", [PROPERTY, UNIT]);
  const columns = "id,property_id,unit_id,tenancy_id,kind,category,status,amount_cents,posted_on,description,payer,amount_knowledge,category_knowledge,status_knowledge,posted_on_knowledge,description_knowledge,payer_knowledge,charge_definition_link_knowledge,property_link_knowledge,unit_link_knowledge,person_link_knowledge,tenancy_link_knowledge,due_on_knowledge,payment_method_knowledge";
  const rows: [string, string, string | null, number | null, string, string | null, string][] = [
    ["tx-charge", "charge", "base_rent", 150000, "2026-08-01", null, "posted"],
    ["tx-pay-tenant", "payment", "base_rent", 100000, "2026-08-03", "tenant", "posted"],
    ["tx-pay-agency", "payment", "subsidy", 40000, "2026-08-05", "agency", "posted"],
    ["tx-deposit", "payment", "security_deposit", 50000, "2026-08-01", "tenant", "posted"],
    ["tx-credit", "credit", "base_rent", 5000, "2026-08-10", null, "posted"],
    ["tx-void", "payment", "base_rent", 999, "2026-08-11", "tenant", "voided"],
    ["tx-late", "charge", "base_rent", 150000, "2026-09-01", null, "posted"],
    ["tx-unknown", "charge", "base_rent", null, "2026-08-15", null, "posted"],
  ];
  for (const [id, kind, category, amount, postedOn, payer, status] of rows) {
    await raw.query(
      `INSERT INTO rent_ops_ledger_transactions (${columns})
       VALUES ($1,$2,$3,'tenancy-1',$4,$5,$6,$7,$8,'synthetic',$9,$10,'manual','manual','manual','manual',$11,'unknown','manual','manual','unknown','manual','unknown','unknown')`,
      [id, PROPERTY, UNIT, kind, category, status, amount, postedOn, payer, amount === null ? "unknown" : "known", payer === null ? "unknown" : "manual"],
    );
  }
  await raw.query(`INSERT INTO rent_ops_security_deposits (id, property_id, unit_id, tenancy_id, person_id, type, amount_held_cents, received_on) VALUES ('dep-1',$1,$2,'tenancy-1','person-1','security',50000,'2026-08-01')`, [PROPERTY, UNIT]);
}

test("the summary bridge preview reports control totals from the rental ledger and refuses to stand in for native receivables", async () => {
  const h = await harness();
  try {
    await seedLedger(h.raw);
    const admin = await h.access();
    const period = { organizationId: ORG, legalEntityId: ENTITY, periodStart: "2026-08-01", periodEnd: "2026-08-31" };
    const noPolicy = await h.operations.previewBridge(admin.principal, period);
    assert.equal(noPolicy.status, "no_policy");
    await h.operations.execute("accounting.rental_posting_policy.set", envelope({ method: "summary_bridge", effectiveFrom: "2026-01-01", cutoffDate: "2026-01-01", reason: "bridge" }), admin);
    const preview = await h.operations.previewBridge(admin.principal, period);
    assert.equal(preview.status, "incomplete_source", "an unknown ledger amount is excluded and reported, never zero");
    assert.equal(preview.controlTotals.excludedUnknownCount, 1);
    assert.match(preview.reason ?? "", /unknown amount/);
    const totals = preview.controlTotals;
    assert.equal(totals.chargesCents, "150000");
    assert.equal(totals.chargeCount, 1);
    assert.deepEqual(totals.receipts, { tenantCents: "100000", subsidyCents: "40000", otherCents: "0", totalCents: "140000", count: 2 });
    assert.equal(totals.depositReceiptsCents, "50000", "deposits are held funds, not receipts against rent");
    assert.equal(totals.depositsReceivedCents, "50000");
    assert.equal(totals.depositsHeldAtEndCents, "50000");
    assert.equal(totals.creditsCents, "5000");
    assert.equal(totals.netReceivableChangeCents, "5000");
    assert.equal(totals.excludedVoidedCount, 1);
    assert.equal(preview.byProperty.length, 1);
    assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal((await h.operations.previewBridge(admin.principal, period)).fingerprint, preview.fingerprint, "the preview is deterministic");
    // A deposit whose receipt date is unknown is excluded and counted, never summed as zero.
    await h.raw.query(`INSERT INTO rent_ops_security_deposits (id, property_id, unit_id, tenancy_id, person_id, type, amount_held_cents, received_on) VALUES ('dep-unknown',$1,$2,'tenancy-1','person-1','security',25000,NULL)`, [PROPERTY, UNIT]);
    const withUnknownDeposit = await h.operations.previewBridge(admin.principal, period);
    assert.equal(withUnknownDeposit.controlTotals.excludedUnknownCount, 2);
    assert.equal(withUnknownDeposit.controlTotals.depositsHeldAtEndCents, "50000");
    await h.raw.query(`DELETE FROM rent_ops_security_deposits WHERE id = 'dep-unknown'`);
    const exported = await h.operations.exportBridgeCsv(admin.principal, period);
    assert.match(exported.csv, /Preview only; nothing was posted to QuickBooks/);
    assert.match(exported.csv, new RegExp(preview.fingerprint));
    assert.match(exported.csv, /^entity,,,150000,1,5000,100000,40000,0,140000,50000,50000,50000,0,0,0,5000,1,0,1$/m);

    const mixed = await h.operations.previewBridge(admin.principal, { ...period, periodStart: "2025-12-01" });
    assert.equal(mixed.status, "mixed_policy");
    const policy = (await h.operations.listPostingPolicies(admin.principal, { organizationId: ORG, legalEntityId: ENTITY })).items[0]!;
    await h.operations.execute("accounting.rental_posting_policy.close", envelope({ policyId: policy.id, effectiveUntil: "2026-08-01", reason: "switch" }, { expectedRevision: policy.recordRevision }), admin);
    await h.operations.execute("accounting.rental_posting_policy.set", envelope({ method: "native_receivables", effectiveFrom: "2026-08-01", cutoffDate: "2026-08-01", invoiceDeliveryVerified: true, openingBalanceBridgeReference: "OB-1", reason: "native" }), admin);
    const conflict = await h.operations.previewBridge(admin.principal, period);
    assert.equal(conflict.status, "method_conflict");
    assert.match(conflict.reason ?? "", /double count/);
  } finally {
    await h.close();
  }
});

test("the bridge net receivable reverses credits and adjustments by direction and leaves deposit credits out", async () => {
  const h = await harness();
  try {
    await h.raw.query("INSERT INTO rent_ops_people (id, first_name, last_name) VALUES ('person-1','Synthetic','Tenant')");
    await h.raw.query("INSERT INTO rent_ops_tenancies (id, property_id, unit_id, primary_person_id, status, created_at) VALUES ('tenancy-1',$1,$2,'person-1','current',now())", [PROPERTY, UNIT]);
    const columns = "id,property_id,unit_id,tenancy_id,kind,category,status,amount_cents,posted_on,description,payer,reversal_of_id,adjustment_direction,amount_knowledge,category_knowledge,status_knowledge,posted_on_knowledge,description_knowledge,payer_knowledge,charge_definition_link_knowledge,property_link_knowledge,unit_link_knowledge,person_link_knowledge,tenancy_link_knowledge,due_on_knowledge,payment_method_knowledge";
    const rows: [string, string, string, number, string | null, string | null][] = [
      ["b-charge", "charge", "base_rent", 100000, null, null],
      ["b-credit", "credit", "base_rent", 5000, null, null],
      ["b-deposit-credit", "credit", "security_deposit", 20000, null, null],
      ["b-rev-credit", "reversal", "base_rent", 5000, "b-credit", null],
      ["b-adj-debit", "adjustment", "base_rent", 3000, null, "debit"],
      ["b-rev-adj-debit", "reversal", "base_rent", 3000, "b-adj-debit", null],
      ["b-adj-credit", "adjustment", "base_rent", 1000, null, "credit"],
      ["b-rev-adj-credit", "reversal", "base_rent", 1000, "b-adj-credit", null],
    ];
    for (const [id, kind, category, amount, reversalOf, direction] of rows) {
      await h.raw.query(
        `INSERT INTO rent_ops_ledger_transactions (${columns})
         VALUES ($1,$2,$3,'tenancy-1',$4,$5,'posted',$6,'2026-08-10','synthetic',NULL,$7,$8,'known','manual','manual','manual','manual','unknown','unknown','manual','manual','unknown','manual','unknown','unknown')`,
        [id, PROPERTY, UNIT, kind, category, amount, reversalOf, direction],
      );
    }
    const admin = await h.access();
    const preview = await h.operations.previewBridge(admin.principal, { organizationId: ORG, legalEntityId: ENTITY, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const totals = preview.controlTotals;
    assert.equal(totals.excludedUnknownCount, 0);
    assert.equal(totals.chargesCents, "100000");
    assert.equal(totals.creditsCents, "5000", "a deposit-category credit is not a rent credit");
    assert.equal(totals.reversalsCents, "9000");
    assert.deepEqual(totals.adjustments, { debitCents: "3000", creditCents: "1000" });
    // Every credit and adjustment was reversed, so only the charge remains receivable.
    assert.equal(totals.netReceivableChangeCents, "100000");
  } finally {
    await h.close();
  }
});

test("period close checklist and connector health report state without changing it", async () => {
  const h = await harness();
  try {
    const admin = await h.access();
    const empty = await h.operations.closeChecklist(admin.principal, { organizationId: ORG, legalEntityId: ENTITY, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    assert.deepEqual(empty.items.map(item => [item.code, item.state]), [
      ["posting_policy", "blocked"], ["sync_complete", "attention"], ["exceptions_resolved", "complete"], ["pm_settlements_reconciled", "not_applicable"], ["deletions_reviewed", "complete"],
    ]);
    await h.operations.execute("accounting.rental_posting_policy.set", envelope({ method: "summary_bridge", effectiveFrom: "2026-01-01", cutoffDate: "2026-01-01", reason: "bridge" }), admin);
    await h.operations.execute("accounting.pm_settlement.create", envelope(pmStatement()), admin);
    const progress = await h.operations.closeChecklist(admin.principal, { organizationId: ORG, legalEntityId: ENTITY, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    assert.equal(progress.items.find(item => item.code === "posting_policy")?.state, "complete");
    assert.equal(progress.items.find(item => item.code === "pm_settlements_reconciled")?.state, "attention");

    await h.raw.query(
      `INSERT INTO accounting_qbo_connections (organization_id, legal_entity_id, environment, realm_id, encrypted_access_token, access_token_iv, access_token_auth_tag, encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag, access_token_expires_at)
       VALUES ($1,$2,'sandbox','555','enc','iv','tag','enc','iv','tag',now())`, [ORG, ENTITY]);
    await h.raw.query(`INSERT INTO accounting_qbo_realm_bindings (organization_id, legal_entity_id, environment, realm_id, provider_company_id, provider_company_name, evidence_version, company_info_hash, confirmed_by) VALUES ($1,$2,'sandbox','555','c1','Synthetic QBO','v1',$3,'demo-admin')`, [ORG, ENTITY, "f".repeat(64)]);
    await h.raw.query(`INSERT INTO accounting_qbo_sync_checkpoints (organization_id, legal_entity_id, environment, realm_id, stream, watermark, cursor, updated_at) VALUES ($1,$2,'sandbox','555','changes','2026-09-23T11:30:00.000Z','verified:2026-09-20T00:00:00.000Z','2026-09-23T11:31:00Z')`, [ORG, ENTITY]);
    await h.raw.query(`INSERT INTO company_jobs (id, organization_id, job_key, topic, payload, state, last_error_code, run_after) VALUES ($1,$2,'k1','accounting.qbo.sync',$3::jsonb,'retry','quickbooks_rate_limited','2026-09-23T12:01:00Z')`, [randomUUID(), ORG, JSON.stringify({ organizationId: ORG, legalEntityId: ENTITY, environment: "sandbox", realmId: "555" })]);
    await h.raw.query(`INSERT INTO company_worker_heartbeats (worker_id, started_at, last_seen_at) VALUES ('worker-1', now(), '2026-09-23T11:59:30Z')`);
    const health = await h.operations.health(admin.principal, { organizationId: ORG });
    assert.equal(health.items.length, 1);
    const item = health.items[0]!;
    assert.equal(item.companyName, "Synthetic QBO");
    assert.equal(item.connection.status, "active");
    assert.equal(item.freshness, "current");
    assert.equal(item.lagSeconds, 1800);
    assert.equal(item.lastVerifiedFullReplayAt, "2026-09-20T00:00:00.000Z");
    assert.equal(item.jobs.retry, 1);
    assert.equal(item.jobs.lastFailureCode, "quickbooks_rate_limited");
    assert.equal(item.rateLimitedUntil, "2026-09-23T12:01:00.000Z");
    assert.equal(health.workers.active, 1);

    const finance = await h.access("finance-1", "finance");
    assert.equal((await h.operations.health(finance.principal, { organizationId: ORG, legalEntityId: ENTITY })).items.length, 1);
    await assert.rejects(h.operations.health(finance.principal, { organizationId: ORG, legalEntityId: randomUUID() }), (error: unknown) => error instanceof CompanyCommandError && error.status === 403);
  } finally {
    await h.close();
  }
});

test("deletion counts are windowed: health shows recent deletions and the close checklist only its period", async () => {
  const h = await harness();
  try {
    const admin = await h.access();
    await h.raw.query(
      `INSERT INTO accounting_qbo_connections (organization_id, legal_entity_id, environment, realm_id, encrypted_access_token, access_token_iv, access_token_auth_tag, encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag, access_token_expires_at)
       VALUES ($1,$2,'sandbox','555','enc','iv','tag','enc','iv','tag',now())`, [ORG, ENTITY]);
    await h.raw.query(`INSERT INTO accounting_qbo_realm_bindings (organization_id, legal_entity_id, environment, realm_id, provider_company_id, provider_company_name, evidence_version, company_info_hash, confirmed_by) VALUES ($1,$2,'sandbox','555','c1','Synthetic QBO','v1',$3,'demo-admin')`, [ORG, ENTITY, "f".repeat(64)]);
    for (const [objectId, detectedAt] of [["900", "2026-02-01T00:00:00Z"], ["901", "2026-08-15T00:00:00Z"], ["902", "2026-09-10T00:00:00Z"]]) {
      await h.raw.query(`INSERT INTO accounting_qbo_deletion_tombstones (organization_id, legal_entity_id, environment, realm_id, object_type, object_id, detected_via, detected_at) VALUES ($1,$2,'sandbox','555','Bill',$3,'cdc',$4)`, [ORG, ENTITY, objectId, detectedAt]);
    }
    const health = await h.operations.health(admin.principal, { organizationId: ORG });
    assert.equal(health.items[0]?.activeTombstones, 1, "only the deletion detected in the last 30 days");
    const august = await h.operations.closeChecklist(admin.principal, { organizationId: ORG, legalEntityId: ENTITY, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
    const deletions = august.items.find(item => item.code === "deletions_reviewed")!;
    assert.equal(deletions.state, "attention");
    assert.match(deletions.detail, /^1 QuickBooks record deleted in this period/);
    const june = await h.operations.closeChecklist(admin.principal, { organizationId: ORG, legalEntityId: ENTITY, periodStart: "2026-06-01", periodEnd: "2026-06-30" });
    assert.equal(june.items.find(item => item.code === "deletions_reviewed")?.state, "complete", "an old deletion does not keep every later close in attention");
  } finally {
    await h.close();
  }
});

test("a QuickBooks refresh request queues one coalesced worker job and refuses a disconnected company", async () => {
  const h = await harness();
  try {
    const admin = await h.access();
    const syncEnvelope = () => envelope({ environment: "sandbox", realmId: "555" });
    await rejects(h.operations.execute("accounting.qbo.sync.request", syncEnvelope(), admin), "qbo_connection_missing");
    await h.raw.query(
      `INSERT INTO accounting_qbo_connections (organization_id, legal_entity_id, environment, realm_id, encrypted_access_token, access_token_iv, access_token_auth_tag, encrypted_refresh_token, refresh_token_iv, refresh_token_auth_tag, access_token_expires_at)
       VALUES ($1,$2,'sandbox','555','enc','iv','tag','enc','iv','tag',now())`, [ORG, ENTITY]);
    const first = await h.operations.execute("accounting.qbo.sync.request", syncEnvelope(), admin);
    const second = await h.operations.execute("accounting.qbo.sync.request", syncEnvelope(), admin);
    assert.equal(first.affectedRecordIds[0], second.affectedRecordIds[0], "a pending refresh absorbs the second request");
    assert.match(second.validationOutcomes[0]!.message, /already queued/);
    const jobs = await h.raw.query<{ topic: string; state: string }>("SELECT topic, state FROM company_jobs");
    assert.deepEqual(jobs.rows, [{ topic: "accounting.qbo.sync", state: "queued" }]);
    await h.raw.query(`UPDATE accounting_qbo_connections SET status = 'needs_reconnect', revoked_at = now(), encrypted_access_token = NULL, access_token_iv = NULL, access_token_auth_tag = NULL, encrypted_refresh_token = NULL, refresh_token_iv = NULL, refresh_token_auth_tag = NULL`);
    await rejects(h.operations.execute("accounting.qbo.sync.request", syncEnvelope(), admin), "qbo_needs_reconnect");
  } finally {
    await h.close();
  }
});
