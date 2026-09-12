import test from "node:test";
import assert from "node:assert/strict";
import { assessAccountHistoryCoverage, type AccountHistoryEvidence, type AccountHistoryRow } from "./account-history-coverage";
const charge: AccountHistoryRow = { kind: "charges", sourceId: "charge:1", postedOn: "2024-01-01", checksum: "source-checksum" };
function proof(sourceRows = [charge]): AccountHistoryEvidence {
  return { artifactSha256: "a".repeat(64), archiveHashVerified: true, observedOn: "2026-09-12", requiredThrough: "2026-09-12",
    tenantPartitionsComplete: { current: true, future: true, past: true }, collectionsComplete: { charges: true, payments: true, credits: true, allocations: true },
    allocationEmbeddingVerified: true, accountJoinVerified: true, targetReadbackVerified: true, sourceRows };
}
test("nonempty ledger never proves complete history", () => {
  const result = assessAccountHistoryCoverage([charge]);
  assert.equal(result.status, "unverified"); assert.equal(result.complete, false); assert.equal(result.kinds.charges.sourceCount, null);
});
test("source identities distinguish reused payment and charge IDs; exact readback proves observation only", () => {
  const rows: AccountHistoryRow[] = [charge, { ...charge, kind: "payments", sourceId: "payment:1" }];
  assert.equal(assessAccountHistoryCoverage(rows, proof(rows)).complete, true);
  assert.equal(assessAccountHistoryCoverage([], proof([])).complete, true);
});
test("missing earlier rows are planned by source identity despite a nonempty newer ledger", () => {
  const newer = { ...charge, sourceId: "charge:2", postedOn: "2026-09-01" };
  const result = assessAccountHistoryCoverage([newer], proof([charge, newer]));
  assert.equal(result.status, "partial"); assert.deepEqual(result.missingSourceRows, [charge]);
  assert.deepEqual(result.kinds.charges.sourceDateRange, { first: "2024-01-01", last: "2026-09-01" });
  assert.equal(assessAccountHistoryCoverage([newer, charge], proof([charge, newer])).missingSourceRows.length, 0);
});
test("duplicates, absent source identity and divergent source checksum fail closed", () => {
  assert.equal(assessAccountHistoryCoverage([charge, charge], proof()).kinds.charges.duplicateAppliedCount, 1);
  assert.equal(assessAccountHistoryCoverage([charge], proof([charge, charge])).complete, false);
  assert.equal(assessAccountHistoryCoverage([{ ...charge, checksum: "changed" }], proof()).complete, false);
  assert.equal(assessAccountHistoryCoverage([], proof([{ ...charge, sourceId: null }])).complete, false);
});
test("local rehearsal, missing Past partition, old snapshot and absent allocation embed cannot verify", () => {
  for (const change of [ { targetReadbackVerified: false }, { archiveHashVerified: false }, { observedOn: "2026-09-07" },
    { allocationEmbeddingVerified: false }, { tenantPartitionsComplete: { current: true, future: true, past: false } } ]) {
    assert.equal(assessAccountHistoryCoverage([charge], { ...proof(), ...change }).complete, false);
  }
});

test("same source receipt cannot conceal changed posting dates or plan duplicate source inserts", () => {
  assert.equal(assessAccountHistoryCoverage([{ ...charge, postedOn: "2026-01-01" }], proof()).complete, false);
  assert.equal(assessAccountHistoryCoverage([], proof([charge, charge])).missingSourceRows.length, 0);
});
