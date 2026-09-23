import assert from "node:assert/strict";
import test from "node:test";
import { queryFor } from "./provider-sync";

test("list queries include inactive records so closed accounts and former customers are never read as deletions", () => {
  assert.equal(queryFor("Account", { floor: null, startPosition: 1 }), "SELECT * FROM Account WHERE Active IN (true, false) ORDERBY MetaData.LastUpdatedTime ASC STARTPOSITION 1 MAXRESULTS 500");
  assert.equal(queryFor("Customer", { floor: "2026-09-10T11:00:00.000Z", startPosition: 3 }), "SELECT * FROM Customer WHERE Active IN (true, false) AND MetaData.LastUpdatedTime >= '2026-09-10T11:00:00.000Z' ORDERBY MetaData.LastUpdatedTime ASC STARTPOSITION 3 MAXRESULTS 500");
  // Transactions have no Active flag.
  assert.equal(queryFor("Bill", { floor: null, startPosition: 1 }), "SELECT * FROM Bill ORDERBY MetaData.LastUpdatedTime ASC STARTPOSITION 1 MAXRESULTS 500");
  // Never ordered or filtered by Id (Intuit removed Id sorting and range filters).
  assert.doesNotMatch(queryFor("Vendor", { floor: null, startPosition: 1 }), /\bId\b/);
  assert.throws(() => queryFor("Bill; SELECT", { floor: null, startPosition: 1 }));
});
