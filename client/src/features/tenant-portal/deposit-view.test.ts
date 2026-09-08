import test from "node:test";
import assert from "node:assert/strict";
import { depositAmounts, depositMoney } from "./deposit-view";
import { mutationPayload } from "../rent-ops/form-payload";

test("unknown held cash remains unavailable while signed source balance stays exact", () => {
  assert.deepEqual(depositAmounts({ amountHeldCents: null, sourceBalanceCents: -155000 }), { held: "Unavailable", sourceBalance: "-$1,550.00" });
  assert.deepEqual(depositAmounts({ amountHeldCents: 0, sourceBalanceCents: 0 }), { held: "$0.00", sourceBalance: "$0.00" });
  assert.deepEqual(depositAmounts({ amountHeldCents: 155000 }), { held: "$1,550.00", sourceBalance: undefined });
  assert.equal(depositMoney(undefined), "Unavailable");
});

test("editing another deposit fact preserves unknown held; zero is an explicit known amount", () => {
  const initial = { id: "deposit:future", revision: 1, amountDollars: "", dispositionNotes: "" };
  assert.deepEqual(mutationPayload("save-security-deposit", { ...initial, dispositionNotes: "Reviewed" }, initial), { id: initial.id, revision: 1, dispositionNotes: "Reviewed" });
  assert.deepEqual(mutationPayload("save-security-deposit", { ...initial, amountDollars: "0" }, initial), { id: initial.id, revision: 1, amountHeldCents: 0 });
});
