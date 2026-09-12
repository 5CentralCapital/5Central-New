import assert from "node:assert/strict";
import test from "node:test";
import { decodeMeteredUtility } from "../api";
import { serializeMeteredUtilities } from "../../../../../server/rent-ops/presentation/entities";
import { createDemoAdminSnapshot } from "../demo";
import { buildRecurringChargeRows, currentMonthlyTotal, buildLedgerRows } from "./tenant-model";

const utility = { utility: "water" as const, billingMethod: "metered" as const, effectiveFrom: "2026-10-01", amountCents: null, amountKnowledge: "unknown" as const };

test("metered utility boundary retains date and unknown amount while withholding evidence", () => {
  const serialized = serializeMeteredUtilities([{ ...utility, evidence: { path: "private" }, reviewedBy: "private" }]);
  assert.deepEqual(serialized, [utility]);
  assert.deepEqual(decodeMeteredUtility(serialized![0]), utility);
  assert.throws(() => decodeMeteredUtility({ ...utility, amountCents: 0 }));
  assert.throws(() => decodeMeteredUtility({ ...utility, amountCents: undefined }));
  assert.throws(() => decodeMeteredUtility({ ...utility, evidence: {} }));
});

test("metered service does not generate a recurring schedule, monthly amount, or ledger row", () => {
  const snapshot = createDemoAdminSnapshot();
  const tenant = snapshot.tenants[0];
  const beforeCharges = buildRecurringChargeRows(tenant, snapshot);
  const beforeLedger = buildLedgerRows(tenant, snapshot);
  tenant.meteredUtilities = [utility];
  const afterCharges = buildRecurringChargeRows(tenant, snapshot);
  assert.deepEqual(afterCharges, beforeCharges);
  assert.equal(currentMonthlyTotal(afterCharges), currentMonthlyTotal(beforeCharges));
  assert.deepEqual(buildLedgerRows(tenant, snapshot), beforeLedger);
});
