import assert from "node:assert/strict";
import test from "node:test";
import { investorDocumentDownloadHref } from "./documents";
import { partiallyKnownMoneyValues, sumMoneyByCurrency } from "./totals";

test("investor agreement links route each document to its own download endpoint", () => {
  const company = investorDocumentDownloadHref("org-1", `company-document:${"a".repeat(64)}`, "entity-1");
  assert.equal(company, `/api/company/org-1/documents/company-document%3A${"a".repeat(64)}/download?legalEntityId=entity-1`);
  assert.equal(investorDocumentDownloadHref("org-1", "document:historical-agreement", "entity-1"), "/api/rent-ops/documents/document%3Ahistorical-agreement/download");
});

test("an unknown remaining obligation is totalled as its minimum plus an unknown, never as exact", () => {
  const totals = sumMoneyByCurrency(partiallyKnownMoneyValues([
    { exactCents: null, knownMinimumCents: "0", currency: "USD" },
    { exactCents: "2500", knownMinimumCents: "2500", currency: "USD" },
  ]));
  assert.deepEqual(totals, [{ currency: "USD", cents: "2500", knownCount: 2, unknownCount: 1 }]);
});
