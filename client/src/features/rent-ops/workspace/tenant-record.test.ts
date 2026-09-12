import assert from "node:assert/strict";
import test from "node:test";
import { createDemoAdminSnapshot } from "../demo";
import type { TenantView } from "../types";
import {
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

