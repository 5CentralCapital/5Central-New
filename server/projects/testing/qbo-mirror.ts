import { SYNTHETIC_COMPANY } from "../../company/testing/synthetic-database";
import { createQboAccountingMirrorStore } from "../../accounting/mirror-store";
import { normalizeQboTransaction } from "../../integrations/quickbooks/normalize";
import { financialSourceReferenceSchema, financialWatermarkSchema } from "../../../shared/accounting/source";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";

/** Synthetic QBO mirror seeding for tests only. Never imported by production code. */
export const SYNTHETIC_QBO_SCOPE = {
  organizationId: SYNTHETIC_COMPANY.organizationId,
  legalEntityId: SYNTHETIC_COMPANY.entityId,
  environment: "sandbox" as const,
  realmId: "900100",
};

const STREAMS = ["accounts", "transactions.purchase", "transactions.bill", "transactions.billpayment", "transactions.deposit"];

export interface SyntheticQboLine {
  readonly id: string;
  readonly amount: string;
  readonly accountId?: string;
  readonly description?: string;
}

/**
 * Seed one posted QBO Purchase with expense lines, the expense account and
 * complete live coverage, then return each line's current source reference.
 */
export async function seedSyntheticQboPurchase(executor: RentOpsQueryExecutor, input: { objectId: string; txnDate: string; lines: readonly SyntheticQboLine[]; vendorId?: string }) {
  if (process.env.NODE_ENV === "production") throw new Error("Synthetic QBO data is unavailable in production");
  const mirror = createQboAccountingMirrorStore(executor);
  const scope = SYNTHETIC_QBO_SCOPE;
  const updatedAt = `${input.txnDate}T14:00:00Z`;
  const body = {
    Id: input.objectId, SyncToken: "0", TxnDate: input.txnDate, CurrencyRef: { value: "USD" },
    PaymentType: "Check", EntityRef: { value: input.vendorId ?? "vendor-1" }, AccountRef: { value: "bank-1" },
    MetaData: { LastUpdatedTime: updatedAt },
    Line: input.lines.map((line) => ({ Id: line.id, Amount: line.amount, AccountBasedExpenseLineDetail: { AccountRef: { value: line.accountId ?? "expense-1" } }, Description: line.description ?? "Synthetic cost" })),
  };
  const normalized = normalizeQboTransaction("Purchase", body);
  if (!normalized.value) throw new Error("Synthetic QBO purchase did not normalize");
  const value = normalized.value;
  const object = await mirror.ingestSourceObject({ scope, objectType: value.objectType, objectId: value.objectId, version: value.version, providerUpdatedAt: value.providerUpdatedAt, providerBody: value.providerBody });
  const transaction = await mirror.ingestTransaction({ sourceObjectId: object.id, scope, objectType: value.objectType, objectId: value.objectId, version: value.version, transactionDate: value.transactionDate, postingState: value.postingState, currency: value.currency, watermark: value.providerUpdatedAt, updatedAt: value.providerUpdatedAt });
  await mirror.beginTransactionRevision({ scope, objectType: "Purchase", objectId: input.objectId, version: value.version, lineIds: value.lines.map((line) => line.lineId) });
  for (const line of value.lines) {
    await mirror.ingestTransactionLine({
      transactionId: transaction.id, sourceObjectId: object.id, source: financialSourceReferenceSchema.parse({ provider: "qbo", ...scope, objectType: value.objectType, objectId: value.objectId, lineId: line.lineId, version: value.version }), lineNumber: line.lineNumber, transactionType: line.transactionType,
      direction: line.direction, flow: line.flow, lineRole: line.lineRole, amountCents: line.amountCents, currency: line.currency, postingState: line.postingState, postedOn: line.postedOn,
      settlementState: line.settlementState, settledOn: line.settledOn, settledAmountCents: line.settledAmountCents, accountObjectId: line.accountObjectId, counterpartyObjectId: line.counterpartyObjectId,
      description: line.description, watermark: updatedAt, updatedAt,
    });
  }
  const accounts = new Set(["expense-1", ...input.lines.map((line) => line.accountId ?? "expense-1")]);
  await mirror.ingestSourceObject({ scope, objectType: "Account", objectId: "bank-1", version: "0", providerUpdatedAt: updatedAt, providerBody: { Id: "bank-1", SyncToken: "0", AccountType: "Bank", MetaData: { LastUpdatedTime: updatedAt } } });
  for (const account of Array.from(accounts)) {
    await mirror.ingestSourceObject({ scope, objectType: "Account", objectId: account, version: "0", providerUpdatedAt: updatedAt, providerBody: { Id: account, SyncToken: "0", AccountType: "Expense", MetaData: { LastUpdatedTime: updatedAt } } });
  }
  for (const stream of STREAMS) {
    await mirror.recordCoverage({
      scope, stream, status: "complete", evidence: "live_provider_readback", basis: "source_transactions", watermark: financialWatermarkSchema.parse({ value: updatedAt, observedAt: updatedAt }),
      coveredFrom: "2020-01-01", coveredThrough: input.txnDate, observedAt: updatedAt, objectCount: 1, transactionCount: 1, lineCount: input.lines.length,
    });
  }
  return input.lines.map((line) => financialSourceReferenceSchema.parse({
    provider: "qbo", ...scope, objectType: "Purchase", objectId: input.objectId, lineId: line.id, version: value.version,
  }));
}
