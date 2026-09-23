import assert from "node:assert/strict";
import test from "node:test";
import { effectiveDebtSelection } from "./panels";

test("debt schedule selection follows the investor's current loans", () => {
  const first = [{ id: "loan-a" }, { id: "loan-b" }];
  assert.equal(effectiveDebtSelection(first, ""), "loan-a", "defaults to the first loan");
  assert.equal(effectiveDebtSelection(first, "loan-b"), "loan-b", "keeps a choice that still exists");
  // Switching investor: the stored loan belongs to the previous account.
  assert.equal(effectiveDebtSelection([{ id: "loan-c" }], "loan-b"), "loan-c", "a stale choice falls back to this investor's first loan");
  // First loan added after the panel mounted with none.
  assert.equal(effectiveDebtSelection([], ""), "");
  assert.equal(effectiveDebtSelection([{ id: "loan-new" }], ""), "loan-new", "a newly added first loan is selected, so the schedule loads");
});

test("investor money reads as dollars everywhere, never as an ISO code with raw cents", async () => {
  const { formatInvestorMoney } = await import("./panels");
  assert.equal(formatInvestorMoney("123456"), "$1,234.56");
  assert.equal(formatInvestorMoney("-50000", "USD"), "-$500.00");
  assert.equal(formatInvestorMoney("5"), "$0.05");
  assert.equal(formatInvestorMoney("100000", "EUR"), "EUR 1,000.00");
  assert.equal(formatInvestorMoney(null), "Unknown");
  // The account workspace uses the same formatter (it once printed "USD 1234.56").
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./workspace.tsx", import.meta.url), "utf8");
  assert.match(source, /const money = formatInvestorMoney;/);
  assert.doesNotMatch(source, /function money\(/, "no second money formatter in the investor workspace");
});
