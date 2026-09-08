import type { RentOpsLedgerTransaction, RentOpsPaymentAllocation, RentOpsRepository, RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { TenantPaymentError, type PaymentAdjustment, type PaymentReceipt, type ProcessorEvent, type TenantPayment } from "./model";

export interface TenantPaymentStore {
  transaction<T>(work: (store: TenantPaymentStore) => Promise<T>): Promise<T>;
  lockAccount(personId: string): Promise<void>;
  snapshot(): Promise<RentOpsSnapshot>;
  list(personId: string): Promise<TenantPayment[]>;
  findByRequest(accountId: string, requestId: string): Promise<TenantPayment | undefined>;
  findForEvent(event: ProcessorEvent): Promise<TenantPayment | undefined>;
  insert(payment: TenantPayment): Promise<void>;
  save(payment: TenantPayment): Promise<void>;
  hasEvent(id: string): Promise<boolean>;
  receipt(receipt: PaymentReceipt): Promise<void>;
  adjustments(paymentId: string): Promise<PaymentAdjustment[]>;
  adjustment(adjustment: PaymentAdjustment): Promise<void>;
  appendLedger(transaction: RentOpsLedgerTransaction): Promise<void>;
  appendAllocation(allocation: RentOpsPaymentAllocation): Promise<void>;
}
const fields = ["id", "account_id", "person_id", "tenancy_id", "property_id", "unit_id", "request_id", "amount_cents", "currency", "status", "checkout_session_id", "payment_intent_id", "checkout_url", "expires_at", "created_at", "updated_at", "posted_on", "current_ledger_id", "current_ledger_cents", "ledger_revision"] as const;
function optional(value: unknown): string | undefined { return value == null ? undefined : value instanceof Date ? value.toISOString() : String(value); }
function payment(row: Record<string, unknown>): TenantPayment {
  return { id: String(row.id), accountId: String(row.account_id), personId: String(row.person_id), tenancyId: String(row.tenancy_id), propertyId: String(row.property_id), unitId: String(row.unit_id), requestId: String(row.request_id), amountCents: Number(row.amount_cents), currency: "usd", status: row.status as TenantPayment["status"], checkoutSessionId: optional(row.checkout_session_id), paymentIntentId: optional(row.payment_intent_id), checkoutUrl: optional(row.checkout_url), expiresAt: optional(row.expires_at)!, createdAt: optional(row.created_at)!, updatedAt: optional(row.updated_at)!, postedOn: optional(row.posted_on)?.slice(0, 10), currentLedgerId: optional(row.current_ledger_id), currentLedgerCents: Number(row.current_ledger_cents), ledgerRevision: Number(row.ledger_revision) };
}
function values(row: TenantPayment): unknown[] { return [row.id, row.accountId, row.personId, row.tenancyId, row.propertyId, row.unitId, row.requestId, row.amountCents, row.currency, row.status, row.checkoutSessionId ?? null, row.paymentIntentId ?? null, row.checkoutUrl ?? null, row.expiresAt, row.createdAt, row.updatedAt, row.postedOn ?? null, row.currentLedgerId ?? null, row.currentLedgerCents, row.ledgerRevision]; }
export class PostgresTenantPaymentStore implements TenantPaymentStore {
  constructor(readonly executor: RentOpsQueryExecutor, readonly repository: RentOpsRepository = new PostgresRentOpsRepository(executor), readonly insideTransaction = false) {}
  transaction<T>(work: (store: TenantPaymentStore) => Promise<T>): Promise<T> {
    if (this.insideTransaction) return work(this);
    if (!this.executor.transaction) throw new TenantPaymentError("payment_atomic_storage_required", 503);
    return this.executor.transaction((executor) => work(new PostgresTenantPaymentStore(executor, new PostgresRentOpsRepository(executor), true)), { readOnly: false });
  }
  async lockAccount(id: string): Promise<void> { await this.executor.query("SELECT id FROM rent_ops_people WHERE id = $1 FOR UPDATE", [id]); }
  snapshot(): Promise<RentOpsSnapshot> { return this.repository.getSnapshot(); }
  async list(personId: string): Promise<TenantPayment[]> { const result = await this.executor.query(`SELECT ${fields.join(",")} FROM rent_ops_tenant_payments WHERE person_id=$1 ORDER BY created_at DESC`, [personId]); return result.rows.map(payment); }
  async findByRequest(accountId: string, requestId: string): Promise<TenantPayment | undefined> { const result = await this.executor.query(`SELECT ${fields.join(",")} FROM rent_ops_tenant_payments WHERE account_id=$1 AND request_id=$2${this.insideTransaction ? " FOR UPDATE" : ""}`, [accountId, requestId]); return result.rows[0] && payment(result.rows[0]); }
  async findForEvent(event: ProcessorEvent): Promise<TenantPayment | undefined> {
    const result = await this.executor.query(`SELECT ${fields.join(",")} FROM rent_ops_tenant_payments WHERE ($1::text IS NOT NULL AND id=$1) OR ($2::text IS NOT NULL AND payment_intent_id=$2) OR ($3::text IS NOT NULL AND checkout_session_id=$3)`, [event.paymentId ?? null, event.paymentIntentId ?? null, event.checkoutSessionId ?? null]);
    if (result.rows.length > 1) throw new TenantPaymentError("payment_identity_conflict");
    return result.rows[0] && payment(result.rows[0]);
  }
  async insert(row: TenantPayment): Promise<void> { await this.executor.query(`INSERT INTO rent_ops_tenant_payments (${fields.join(",")}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(",")})`, values(row)); }
  async save(row: TenantPayment): Promise<void> { const columns = fields.slice(9); const vals = values(row).slice(9); await this.executor.query(`UPDATE rent_ops_tenant_payments SET ${columns.map((field, i) => `${field}=$${i + 2}`).join(",")} WHERE id=$1`, [row.id, ...vals]); }
  async hasEvent(id: string): Promise<boolean> { return (await this.executor.query("SELECT id FROM rent_ops_payment_events WHERE id=$1", [id])).rows.length > 0; }
  async receipt(row: PaymentReceipt): Promise<void> { await this.executor.query("INSERT INTO rent_ops_payment_events(id,event_type,payment_id,provider_created_at,outcome,received_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING", [row.id, row.eventType, row.paymentId ?? null, row.providerCreatedAt, row.outcome, row.receivedAt]); }
  async adjustments(id: string): Promise<PaymentAdjustment[]> { const result = await this.executor.query("SELECT payment_id,provider_object_id,kind,amount_cents,active,provider_created_at,terminal FROM rent_ops_payment_adjustments WHERE payment_id=$1", [id]); return result.rows.map((row) => ({ paymentId: String(row.payment_id), providerObjectId: String(row.provider_object_id), kind: row.kind as "refund" | "dispute", amountCents: Number(row.amount_cents), active: row.active === true, providerCreatedAt: Number(row.provider_created_at), terminal: row.terminal === true })); }
  async adjustment(row: PaymentAdjustment): Promise<void> { await this.executor.query("INSERT INTO rent_ops_payment_adjustments(payment_id,provider_object_id,kind,amount_cents,active,provider_created_at,terminal) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(payment_id,provider_object_id) DO UPDATE SET active=EXCLUDED.active,provider_created_at=EXCLUDED.provider_created_at,terminal=EXCLUDED.terminal", [row.paymentId, row.providerObjectId, row.kind, row.amountCents, row.active, row.providerCreatedAt, row.terminal]); }
  async appendLedger(row: RentOpsLedgerTransaction): Promise<void> { await this.repository.saveLedgerTransaction(row); }
  async appendAllocation(row: RentOpsPaymentAllocation): Promise<void> { await this.repository.savePaymentAllocation(row); }
}
