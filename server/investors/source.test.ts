import assert from "node:assert/strict";
import test from "node:test";
import { companyScopeSchema } from "../../shared/company";
import {
  investorFinancialSourceRequestSchema,
  investorPaymentAmountsSchema,
} from "../../shared/investors";
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQboAccountingMirrorStore } from "../accounting/mirror-store";
import { normalizeQboTransaction } from "../integrations/quickbooks/normalize";
import { createAccountingInvestorSourceResolver } from "./source";

const organizationId = "10000000-0000-4000-8000-000000000001";
const legalEntityId = "20000000-0000-4000-8000-000000000001";
const reference = {
  provider: "qbo" as const,
  organizationId,
  legalEntityId,
  environment: "production" as const,
  realmId: "123456789",
  objectType: "Deposit",
  objectId: "deposit-1",
  lineId: "line-1",
  version: "v2",
};

function request(objectType = "Deposit", kind: "contribution" | "distribution" = "contribution") {
  return {
    scope: companyScopeSchema.parse({ organizationId, legalEntityId }),
    accountId: "30000000-0000-4000-8000-000000000001",
    instrumentId: "40000000-0000-4000-8000-000000000001",
    paymentId: "50000000-0000-4000-8000-000000000001",
    amountCents: "500",
    currency: "USD",
    kind,
    amounts: investorPaymentAmountsSchema.parse({ principalCents: kind === "contribution" ? "500" : "0", interestCents: "0", returnOfCapitalCents: "0", distributionCents: kind === "distribution" ? "500" : "0", feeCents: "0", balloonCents: "0" }),
    source: investorFinancialSourceRequestSchema.parse({ currency: "USD", amountCents: "500", reference: { ...reference, objectType }, provider: "qbo" }),
    expectedCounterparties: [{ provider: "qbo" as const, organizationId, legalEntityId, environment: "production" as const, realmId: reference.realmId, objectType: "Customer" as const, objectId: "investor-contact" }],
  };
}

function resolver() {
  const resolution = {
    source: { ...reference },
    direction: "debit" as const,
    flow: "incoming" as const,
    lineRole: "receipt" as const,
    amountCents: "1000" as const,
    currency: "USD" as const,
    transactionType: "Deposit",
    accountObjectId: "cash-account",
    counterpartyObjectId: "investor-contact",
    description: "Investor contribution",
    postingState: "posted" as const,
    postedOn: "2026-09-01",
    settlement: { state: "unknown" as const, settledOn: null, settledAmountCents: null },
    watermark: { value: "w2", observedAt: "2026-09-02T00:00:00Z" },
  };
  return createAccountingInvestorSourceResolver({
    read: {
      resolveLine: async () => resolution,
      readCoverage: async () => { throw new Error("unused"); },
      listTransactions: async () => { throw new Error("unused"); },
    },
    allocations: {
      getBalance: async () => ({ source: reference, lineAmountCents: "1000", allocatedCents: "0", availableCents: "1000", currency: "USD" }),
      reserve: async () => ({ source: reference, lineAmountCents: "1000", allocatedCents: "500", availableCents: "500", currency: "USD" }),
      release: async () => ({ source: reference, lineAmountCents: "1000", allocatedCents: "0", availableCents: "1000", currency: "USD" }),
    },
    resolvePaymentContext: async () => ({ paymentType: "Deposit", accountObjectId: "cash-account", counterpartyObjectId: "investor-contact", counterpartyObjectType: "Customer", legalEntityId, purpose: "capital_contribution", purposeEvidence: "server_mapping", purposeMappedAt: "2026-09-02T00:00:00Z" }),
  });
}

test("QBO source verification allows a partial allocation and returns mirror metadata", async () => {
  const verified = await resolver().verifyPostedPayment(request());
  assert.ok(verified);
  assert.equal(verified.source.provider, "qbo");
  assert.equal(verified.source.amountCents, "1000");
  assert.equal(verified.source.verifiedAt, "2026-09-02T00:00:00Z");
  assert.equal(verified.source.watermark.value, "w2");
});

test("provider party authorization matches QBO type, id, realm, and entity", async () => {
  const input = { ...request(), expectedCounterparties: [{ provider: "qbo" as const, organizationId, legalEntityId, environment: "production" as const, realmId: reference.realmId, objectType: "Customer" as const, objectId: "investor-contact" }] };
  assert.ok(await resolver().verifyPostedPayment(input));
  assert.equal(await resolver().verifyPostedPayment({ ...input, expectedCounterparties: [{ ...input.expectedCounterparties[0], objectType: "Vendor" as const }] }), null);
  assert.equal(await resolver().verifyPostedPayment({ ...input, expectedCounterparties: [{ ...input.expectedCounterparties[0], realmId: "999" }] }), null);
});

test("a generic transfer or missing provider context stays unverified", async () => {
  assert.equal(await resolver().verifyPostedPayment(request("Transfer")), null);
  const noContext = createAccountingInvestorSourceResolver({
    read: { resolveLine: async () => null, readCoverage: async () => { throw new Error("unused"); }, listTransactions: async () => { throw new Error("unused"); } },
    allocations: { getBalance: async () => { throw new Error("unused"); }, reserve: async () => { throw new Error("unused"); }, release: async () => { throw new Error("unused"); } },
  });
  assert.equal(await noContext.verifyPostedPayment(request()), null);
});

test("provider purpose is required and must match the investor component", async () => {
  const base = resolver();
  const receiptMismatch = createAccountingInvestorSourceResolver({
    read: { resolveLine: async () => ({
      source: reference,
      direction: "debit" as const,
      flow: "incoming" as const,
      lineRole: "receipt" as const,
      amountCents: "1000" as const,
      currency: "USD" as const,
      transactionType: "Deposit",
      accountObjectId: "cash-account",
      counterpartyObjectId: "investor-contact",
      description: "Rent receipt",
      postingState: "posted" as const,
      postedOn: "2026-09-01",
      settlement: { state: "unknown" as const, settledOn: null, settledAmountCents: null },
      watermark: { value: "w2", observedAt: "2026-09-02T00:00:00Z" },
    }), readCoverage: async () => { throw new Error("unused"); }, listTransactions: async () => { throw new Error("unused"); } },
    paymentContext: { readPaymentContext: async () => ({
      source: reference, cashAccountObjectId: "cash-account", payeeObjectId: "investor-contact", payeeObjectType: "Customer" as const,
      accountType: "Bank", accountSubType: null, purpose: "rent_receipt" as const, purposeEvidence: "server_mapping" as const, purposeMappedAt: "2026-09-02T00:00:00Z",
      flow: "incoming" as const, amountCents: "1000", currency: "USD", postedOn: "2026-09-01", postingState: "posted" as const, subtype: "Deposit" as const, providerUpdatedAt: "2026-09-02T00:00:00Z", watermark: { value: "w2", observedAt: "2026-09-02T00:00:00Z" },
    }) },
    allocations: { reserve: async () => { throw new Error("must not reserve"); }, getBalance: async () => { throw new Error("unused"); }, release: async () => { throw new Error("unused"); } },
  });
  assert.equal(await receiptMismatch.verifyPostedPayment(request()), null);
  assert.ok(await base.verifyPostedPayment(request()));
});

test("provider-shaped Purchase uses the mirrored cash account and Vendor context", async () => {
  const database = await createSyntheticCompanyDatabase();
  try {
    const mirror = createQboAccountingMirrorStore(database.executor);
    const providerScope = {
      organizationId: SYNTHETIC_COMPANY.organizationId,
      legalEntityId: SYNTHETIC_COMPANY.entityId,
      environment: "sandbox" as const,
      realmId: "123456",
    };
    const source = {
      provider: "qbo" as const,
      ...providerScope,
      objectType: "Purchase",
      objectId: "purchase-101",
      lineId: "1",
      version: "0",
    };
    const updatedAt = "2026-09-21T14:00:00Z";
    const body = {
      Id: "purchase-101", SyncToken: "0", TxnDate: "2026-09-20", CurrencyRef: { value: "USD" },
      PaymentType: "Check", EntityRef: { value: "vendor-1" }, AccountRef: { value: "bank-1" },
      MetaData: { LastUpdatedTime: updatedAt },
      Line: [{ Id: "1", Amount: "125.40", AccountBasedExpenseLineDetail: { AccountRef: { value: "expense-1" } }, Description: "Materials" }],
    };
    const normalized = normalizeQboTransaction("Purchase", body);
    assert.ok(normalized.value);
    const normalizedLine = normalized.value.lines[0];
    assert.ok(normalizedLine);
    const normalizedObject = normalized.value;
    const object = await mirror.ingestSourceObject({ scope: providerScope, objectType: normalizedObject.objectType, objectId: normalizedObject.objectId, version: normalizedObject.version, providerUpdatedAt: normalizedObject.providerUpdatedAt, providerBody: normalizedObject.providerBody });
    const transaction = await mirror.ingestTransaction({ sourceObjectId: object.id, scope: providerScope, objectType: normalizedObject.objectType, objectId: normalizedObject.objectId, version: normalizedObject.version, transactionDate: normalizedObject.transactionDate, postingState: normalizedObject.postingState, currency: normalizedObject.currency, watermark: normalizedObject.providerUpdatedAt, updatedAt: normalizedObject.providerUpdatedAt });
    await mirror.beginTransactionRevision({ scope: providerScope, objectType: "Purchase", objectId: "purchase-101", version: "0", lineIds: ["1"] });
    await mirror.ingestTransactionLine({ transactionId: transaction.id, sourceObjectId: object.id, source: { ...source, version: normalizedObject.version }, lineNumber: normalizedLine.lineNumber, transactionType: normalizedLine.transactionType, direction: normalizedLine.direction, flow: normalizedLine.flow, lineRole: normalizedLine.lineRole, amountCents: normalizedLine.amountCents, currency: normalizedLine.currency, postingState: normalizedLine.postingState, postedOn: normalizedLine.postedOn, settlementState: normalizedLine.settlementState, settledOn: normalizedLine.settledOn, settledAmountCents: normalizedLine.settledAmountCents, accountObjectId: normalizedLine.accountObjectId, counterpartyObjectId: normalizedLine.counterpartyObjectId, description: normalizedLine.description, watermark: updatedAt, updatedAt });
    await mirror.ingestSourceObject({ scope: providerScope, objectType: "Account", objectId: "bank-1", version: "0", providerUpdatedAt: updatedAt, providerBody: { Id: "bank-1", SyncToken: "0", AccountType: "Bank", MetaData: { LastUpdatedTime: updatedAt } } });
    await mirror.ingestSourceObject({ scope: providerScope, objectType: "Account", objectId: "expense-1", version: "0", providerUpdatedAt: updatedAt, providerBody: { Id: "expense-1", SyncToken: "0", AccountType: "Expense", MetaData: { LastUpdatedTime: updatedAt } } });
    const resolver = createAccountingInvestorSourceResolver({ read: mirror, allocations: mirror, paymentContext: mirror });
    const verified = await resolver.verifyPostedPayment({
      scope: companyScopeSchema.parse({ organizationId: providerScope.organizationId, legalEntityId: providerScope.legalEntityId }),
      accountId: "30000000-0000-4000-8000-000000000001", instrumentId: "40000000-0000-4000-8000-000000000001", paymentId: "50000000-0000-4000-8000-000000000001",
      amountCents: "12540", currency: "USD", kind: "distribution",
      amounts: investorPaymentAmountsSchema.parse({ principalCents: "0", interestCents: "0", returnOfCapitalCents: "0", distributionCents: "12540", feeCents: "0", balloonCents: "0" }),
      source: investorFinancialSourceRequestSchema.parse({ provider: "qbo", reference: source, currency: "USD", amountCents: "12540" }),
      expectedCounterparties: [{ provider: "qbo", organizationId: providerScope.organizationId, legalEntityId: providerScope.legalEntityId, environment: "sandbox", realmId: providerScope.realmId, objectType: "Vendor", objectId: "vendor-1" }],
    });
    // The mirror proves provider cash, subtype, payee and entity, but its
    // unmapped purpose cannot prove an investor distribution. The resolver
    // must hold this unrelated expense until accounting supplies a dated
    // purpose mapping.
    assert.equal(verified, null);
    assert.equal((await mirror.getBalance(source)).allocatedCents, "0");
  } finally {
    await database.close();
  }
});
