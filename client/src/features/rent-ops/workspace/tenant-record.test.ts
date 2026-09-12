import assert from "node:assert/strict";
import test from "node:test";
import { createDemoAdminSnapshot } from "../demo";
import type { TenantView } from "../types";
import {
  currentMonthlyTotal,
  ledgerEntryReference,
  filterTenantLedger,
  ledgerActionEligibility,
  isCurrentTenancy,
  resolveTenantContext,
  buildLedgerRows,
  buildRecurringChargeRows,
  buildTenantEditActions,
  classifyRecurringSchedule,
  filterRecurringCharges,
  recurringChargeScope,
  resolveTenantBalance,
} from "./tenant-model";

test("recurring charges retain scope identity and classify date boundaries", () => {
  const snapshot = createDemoAdminSnapshot();
  const tenant = snapshot.tenants[0];
  const propertyId = tenant.property?.id;
  const unitId = tenant.unit?.id;
  const rows = buildRecurringChargeRows(tenant, snapshot, "2026-08-16");
  const inferred = rows.find((row) => row.id === "demo-schedule-a-rent");
  assert.equal(inferred?.scope.type, "tenant");
  assert.equal(inferred?.scope.identitySource, "inferred");
  assert.equal(inferred?.scope.label, "Sample Resident A");

  const explicitUnit = { id: "unit-scope", scopeType: "unit", scopeId: unitId, propertyId, unitId, description: "Unit water", amountCents: 4000, effectiveFrom: "2026-08-16", effectiveTo: "2026-08-16", active: true };
  const explicitProperty = { id: "property-scope", scopeType: "property", scopeId: propertyId, propertyId, description: "Property fee", amountCents: 1000, effectiveFrom: "2026-08-17", active: true };
  const ended = { id: "ended", propertyId, unitId, tenancyId: tenant.tenancy?.id, amountCents: 1000, effectiveFrom: "2026-07-01", effectiveTo: "2026-08-15", active: true };
  const inactive = { id: "inactive", propertyId, unitId, tenancyId: tenant.tenancy?.id, amountCents: 1000, effectiveFrom: "2026-09-01", active: false };
  const unknown = { id: "unknown", propertyId, unitId, tenancyId: tenant.tenancy?.id, amountCents: null, effectiveFrom: null, active: null };
  const withExtra = { ...tenant, schedules: [...tenant.schedules, explicitUnit, explicitProperty, ended, inactive, unknown] } as TenantView;
  const mapped = buildRecurringChargeRows(withExtra, snapshot, "2026-08-16");
  const unitRow = mapped.find((row) => row.id === "unit-scope");
  assert.equal(unitRow?.scope.type, "unit");
  assert.equal(unitRow?.scope.identitySource, "explicit");
  assert.equal(unitRow?.state, "current", "end date equal to as-of remains current");
  assert.equal(mapped.find((row) => row.id === "property-scope")?.state, "future");
  assert.equal(mapped.find((row) => row.id === "ended")?.state, "ended");
  assert.equal(mapped.find((row) => row.id === "inactive")?.state, "ended", "inactive schedules remain in ended history even if their date is future");
  assert.equal(mapped.find((row) => row.id === "unknown")?.state, "unknown");
  assert.equal(filterRecurringCharges(mapped, "current").some((row) => row.id === "unknown"), true, "uncertain rows stay visible in the current review");
  assert.equal(filterRecurringCharges(mapped, "future").some((row) => row.id === "property-scope"), true);
  assert.equal(filterRecurringCharges(mapped, "ended").some((row) => row.id === "ended"), true);
  assert.equal(classifyRecurringSchedule({ effectiveFrom: "2026-08-16", effectiveTo: "2026-08-16", active: true }, "2026-08-16"), "current");
});

test("ledger mapping separates charge, payment, and credit without inventing balances", () => {
  const snapshot = createDemoAdminSnapshot();
  const base = snapshot.tenants[0];
  const tenant: TenantView = {
    ...base,
    ledger: [
      { transaction: { id: "charge-1", unitId: base.unit?.id, kind: "charge", status: "posted", amountCents: 120000, postedOn: "2026-08-01", description: "August rent" }, runningBalanceCents: 120000 },
      { transaction: { id: "payment-1", unitId: base.unit?.id, kind: "payment", amountCents: 100000, postedOn: "2026-08-03", description: "Check" }, runningBalanceCents: 20000 },
      { transaction: { id: "credit-1", unitId: base.unit?.id, kind: "credit", amountCents: 5000, postedOn: "2026-08-04", description: "Service credit" }, runningBalanceCents: null, balanceComplete: false, balanceUncertaintyCodes: ["allocation_pending"] },
    ],
  };
  const rows = buildLedgerRows(tenant, snapshot);
  assert.equal(rows[0].chargeCents, 120000);
  assert.equal(rows[0].paymentCents, null);
  assert.equal(rows[1].chargeCents, null);
  assert.equal(rows[1].paymentCents, 100000);
  assert.equal(rows[1].paymentLabel, "Payment");
  assert.equal(rows[2].paymentCents, 5000);
  assert.equal(rows[2].paymentLabel, "Credit");
  assert.equal(rows[2].runningBalanceCents, null, "a missing running balance is not recomputed from the row amount");
  assert.equal(rows[2].statusKnown, false);
  assert.equal(rows[2].uncertaintyCodes.includes("allocation_pending"), true);
  assert.equal(rows[2].uncertaintyCodes.includes("status_unknown"), true);
});

test("tenant balance prefers the matching report and exposes incomplete amounts as review", () => {
  const snapshot = createDemoAdminSnapshot();
  const base = snapshot.tenants[0];
  snapshot.delinquency = [{ personId: base.person.id, tenancyId: base.tenancy?.id, totalBalanceCents: 8750, balanceComplete: false, balanceUncertaintyCodes: ["unapplied_cash"] }];
  const reported = resolveTenantBalance(base, snapshot);
  assert.equal(reported.source, "delinquency");
  assert.equal(reported.amountCents, null);
  assert.equal(reported.reportedAmountCents, 8750);
  assert.equal(reported.complete, false);

  snapshot.delinquency = [];
  const withLedger: TenantView = {
    ...base,
    ledger: [{ transaction: { id: "ledger-1", kind: "charge", amountCents: 5000, postedOn: "2026-08-01" }, runningBalanceCents: 5000 }],
  };
  const fromLedger = resolveTenantBalance(withLedger, snapshot);
  assert.equal(fromLedger.source, "ledger");
  assert.equal(fromLedger.amountCents, 5000);
  assert.equal(fromLedger.complete, true);
});

test("contextual edit actions keep record revisions and predecessor revisions", () => {
  const snapshot = createDemoAdminSnapshot();
  const base = snapshot.tenants[0];
  const tenant: TenantView = {
    ...base,
    person: { ...base.person, recordRevision: 9 },
    tenancies: [{ ...base.tenancy!, recordRevision: 7 }],
    tenancy: { ...base.tenancy!, recordRevision: 7 },
    leaseTerms: [{ ...base.leaseTerms[0], recordRevision: 6 }],
    schedules: [{ ...base.schedules[0], recordRevision: 5 }],
  };
  const summaryAction = buildTenantEditActions(tenant, snapshot, "summary")[0];
  assert.equal(summaryAction.values.revision, 9);
  const tenancyActions = buildTenantEditActions(tenant, snapshot, "tenancy");
  assert.equal(tenancyActions.find((action) => action.action === "save-tenancy")?.values.revision, 7);
  assert.equal(tenancyActions.find((action) => action.action === "save-lease-term")?.values.revision, 6);
  const chargeActions = buildTenantEditActions(tenant, snapshot, "charges");
  const replace = chargeActions.find((action) => action.action === "replace-recurring-schedule");
  const end = chargeActions.find((action) => action.action === "end-recurring-schedule");
  assert.equal(replace?.values.predecessorId, base.schedules[0].id);
  assert.equal(replace?.values.expectedRevision, 5);
  assert.equal(end?.values.predecessorId, base.schedules[0].id);
  assert.equal(end?.values.expectedRevision, 5);
});

test("recurring scope labels flag missing identity instead of showing an opaque card", () => {
  const snapshot = createDemoAdminSnapshot();
  const tenant = snapshot.tenants[0];
  const scope = recurringChargeScope({ id: "scope-unknown", amountCents: 1000, effectiveFrom: "2026-08-01", active: true }, tenant, snapshot);
  assert.equal(scope.type, "unknown");
  assert.equal(scope.label, "Needs review");
  assert.equal(scope.identitySource, "unknown");
  assert.ok(scope.warning);
});


test('tenant balance cannot use another resident delinquency row merely because property matches',()=>{
  const snapshot=createDemoAdminSnapshot();
  const tenant=structuredClone(snapshot.tenants[0]);
  tenant.ledger=[];
  snapshot.delinquency=[{personId:'other-person',tenancyId:'other-tenancy',propertyId:tenant.tenancy!.propertyId,totalBalanceCents:987600,balanceComplete:true}];
  const balance=resolveTenantBalance(tenant,snapshot);
  assert.equal(balance.amountCents,null);
  assert.equal(balance.source,'unavailable');
});

test('incomplete ledger rows cannot present supplied numeric running balances as confirmed',()=>{
  const snapshot=createDemoAdminSnapshot();
  const tenant=structuredClone(snapshot.tenants[0]);
  tenant.ledger=[{transaction:{id:'incomplete-charge',kind:'charge',status:'posted',amountCents:1000,postedOn:'2026-08-15'},runningBalanceCents:1000,allocatedCents:0,openCents:1000,balanceComplete:false,balanceUncertaintyCodes:['allocation_evidence_unknown']}];
  assert.equal(buildLedgerRows(tenant,snapshot)[0].runningBalanceCents,null);
  assert.equal(buildLedgerRows(tenant,snapshot)[0].allocatedCents,null);
  assert.equal(buildLedgerRows(tenant,snapshot)[0].openCents,null);
});

test('unknown schedule activation cannot be categorized as confirmed current',()=>{
  assert.equal(classifyRecurringSchedule({id:'unknown-active',effectiveFrom:'2026-08-01',active:null,amountCents:1000,billingFrequency:null},'2026-08-15'),'unknown');
});

test('actual move-out is exclusive but cancelled tenancy cannot be resurrected by old move-in date',()=>{
  assert.equal(isCurrentTenancy({id:'moved-out',status:'current',actualMoveInOn:'2026-08-01',actualMoveOutOn:'2026-08-15'},'2026-08-15'),false);
  assert.equal(isCurrentTenancy({id:'cancelled',status:'cancelled',actualMoveInOn:'2026-08-01'},'2026-08-15'),false);
});

test("monthly totals require known candidate facts and exclude nonmonthly schedules", () => {
  const snapshot = createDemoAdminSnapshot();
  const tenant = snapshot.tenants[0];
  const schedule = { ...tenant.schedules[0], active: true, billingFrequency: "monthly", amountCents: 12000, effectiveFrom: "2026-08-01", effectiveTo: null };
  const rows = buildRecurringChargeRows({ ...tenant, schedules: [schedule] }, snapshot, "2026-08-16");
  assert.equal(currentMonthlyTotal(rows), 12000);
  assert.equal(currentMonthlyTotal(rows, false), null);
  assert.equal(currentMonthlyTotal([...rows, { ...rows[0], billingFrequency: "annual", amountCents: 90000 }]), 12000);
  assert.equal(currentMonthlyTotal([...rows, { ...rows[0], billingFrequency: "one_time", amountCents: 80000 }]), 12000);
  assert.equal(currentMonthlyTotal([...rows, { ...rows[0], billingFrequency: null }]), null);
  assert.equal(currentMonthlyTotal([...rows, { ...rows[0], state: "unknown" }]), null);
});

test("ledger actions exclude derived entries, reversals, uncertain statuses, and reversed originals", () => {
  const snapshot = createDemoAdminSnapshot();
  const tenant = snapshot.tenants[0];
  const transaction = { id: "payment", kind: "payment", status: "posted", category: "base_rent", propertyId: tenant.property!.id, amountCents: 10000, postedOn: "2026-08-01", description: "Receipt" };
  const row = buildLedgerRows({ ...tenant, ledger: [{ transaction, allocatedCents: 2000, openCents: 8000 }] }, snapshot)[0];
  assert.deepEqual(ledgerActionEligibility(row, [row]), { reverse: true, allocate: true });
  for (const patch of [{ id: "shared-application:a" }, { status: undefined }, { status: "voided" }, { statusKnowledge: "unknown" }, { kind: "reversal", reversalOfId: "old" }]) {
    const invalid = { ...row, transaction: { ...transaction, ...patch } };
    assert.deepEqual(ledgerActionEligibility(invalid, [invalid]), { reverse: false, allocate: false });
  }
  const reversal = { ...row, transaction: { ...transaction, id: "reversal", kind: "reversal", reversalOfId: "payment" } };
  assert.deepEqual(ledgerActionEligibility(row, [row, reversal]), { reverse: false, allocate: false });
  assert.equal(ledgerActionEligibility({ ...row, openCents: 0 }, [row]).allocate, false);
});

test("profile tenancy is authoritative and inherited schedule actions name their shared scope", () => {
  const snapshot = createDemoAdminSnapshot();
  const tenant = snapshot.tenants[0];
  const historical = { ...tenant.tenancy!, id: "historical", status: "cancelled" };
  assert.equal(resolveTenantContext({ ...tenant, tenancy: historical, tenancies: [tenant.tenancy!, historical] }, snapshot).currentTenancy?.id, "historical");
  const schedule = { ...tenant.schedules[0], scopeType: "property", scopeId: tenant.property!.id };
  const actions = buildTenantEditActions({ ...tenant, schedules: [schedule] }, snapshot, "charges");
  assert.ok(actions.find(action => action.label.startsWith("Replace shared property charge")));
  assert.ok(actions.find(action => action.label.startsWith("End shared property charge")));
});

test("ledger entry labels never expose opaque identifiers and filters preserve account balances and order", () => {
  assert.equal(ledgerEntryReference({ id: "billing:40064a2c", kind: "charge" }), "Monthly billing");
  assert.equal(ledgerEntryReference({ id: "tp_random_ledger_1", kind: "payment" }), "Payment");
  assert.equal(ledgerEntryReference({ id: "opaque" }), "—");
  const snapshot = createDemoAdminSnapshot();
  const tenant = snapshot.tenants[0];
  const rows = buildLedgerRows({ ...tenant, ledger: [
    { transaction: { id: "first", description: "Rent", postedOn: "2026-08-01", kind: "charge" }, runningBalanceCents: 10000 },
    { transaction: { id: "second", description: "Check payment", postedOn: "2026-08-02", kind: "payment" }, runningBalanceCents: 5000 },
    { transaction: { id: "third", description: "Check payment", postedOn: "2026-08-03", kind: "payment" }, runningBalanceCents: 2000 },
  ] }, snapshot);
  const filtered = filterTenantLedger(rows, "CHECK", "2026-08-02", "2026-08-03");
  assert.deepEqual(filtered.map(row => row.key), ["second", "third"]);
  assert.deepEqual(filtered.map(row => row.runningBalanceCents), [5000, 2000]);
  assert.equal(filtered[0], rows[1]);
});
