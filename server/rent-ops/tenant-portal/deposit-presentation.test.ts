import test from "node:test";
import assert from "node:assert/strict";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { presentTenantHome } from "./presentation";

 test("tenant deposit presentation retains unknown held cash and exact signed source balance", () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  const deposit = snapshot.securityDeposits.find((row) => row.personId === "demo-person-1" && row.tenancyId === "demo-tenancy-1")!;
  assert.ok(deposit);
  deposit.amountHeldCents = null;
  deposit.sourceBalanceCents = -155000;
  const identity = { id: "tenant:test", email: "tenant@example.test", personId: "demo-person-1", tenancyId: "demo-tenancy-1", status: "active" as const };
  const unknown = presentTenantHome(snapshot, identity, "2026-09-07")!.deposits.find((row) => row.id === deposit.id)!;
  assert.ok(unknown);
  assert.equal(unknown.amountHeldCents, null);
  assert.equal(unknown.sourceBalanceCents, -155000);
  deposit.amountHeldCents = 0;
  const zero = presentTenantHome(snapshot, identity, "2026-09-07")!.deposits.find((row) => row.id === deposit.id)!;
  assert.equal(zero.amountHeldCents, 0);
  deposit.amountHeldCents = 155000;
  assert.equal(presentTenantHome(snapshot, identity, "2026-09-07")!.deposits.find((row) => row.id === deposit.id)!.amountHeldCents, 155000);
});
