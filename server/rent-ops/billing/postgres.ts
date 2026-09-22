import type { IsoMonth, RentOpsLedgerTransaction } from "../../../shared/rent-ops-contracts";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { BillingError, type BillingData, type BillingReceipt, type BillingStore, type BillingWriteContext } from "./service";

export class PostgresBillingStore implements BillingStore {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  private context(executor: RentOpsQueryExecutor): BillingWriteContext {
    const repository = new PostgresRentOpsRepository(executor, true);
    return {
      async read(month: IsoMonth): Promise<BillingData> {
        const snapshot = await repository.getSnapshot();
        const result = await executor.query<{
          lineage_root_id: string; schedule_id: string; billing_on: string; ledger_transaction_id: string;
          tenancy_id: string; amount_cents: number | string; preview_token: string; actor_subject: string; posted_at: string;
        }>("SELECT lineage_root_id, schedule_id, billing_on::text, ledger_transaction_id, tenancy_id, amount_cents, preview_token, actor_subject, posted_at::text FROM rent_ops_billing_charges WHERE billing_on = $1::date ORDER BY lineage_root_id", [`${month}-01`]);
        return { snapshot, receipts: result.rows.map((row) => ({
          lineageRootId: row.lineage_root_id, scheduleId: row.schedule_id, billingOn: row.billing_on,
          ledgerTransactionId: row.ledger_transaction_id, tenancyId: row.tenancy_id, amountCents: Number(row.amount_cents),
          previewToken: row.preview_token, actorSubject: row.actor_subject, postedAt: row.posted_at,
        })) };
      },
      async insert(transaction: RentOpsLedgerTransaction, receipt: BillingReceipt): Promise<void> {
        await repository.saveLedgerTransaction(transaction);
        // Unique lineage/date and ledger keys are the final durable fence.
        // No ON CONFLICT UPDATE path can mutate or relink an earlier charge.
        await executor.query("INSERT INTO rent_ops_billing_charges (lineage_root_id, schedule_id, billing_on, ledger_transaction_id, tenancy_id, amount_cents, preview_token, actor_subject, posted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
          receipt.lineageRootId, receipt.scheduleId, receipt.billingOn, receipt.ledgerTransactionId,
          receipt.tenancyId, receipt.amountCents, receipt.previewToken, receipt.actorSubject, receipt.postedAt,
        ]);
      },
    };
  }

  async read(month: IsoMonth): Promise<BillingData> {
    if (!this.executor.transaction) throw new BillingError("billing_unavailable", 503);
    return this.executor.transaction((executor) => this.context(executor).read(month), { readOnly: true });
  }

  async transaction<T>(month: IsoMonth, work: (context: BillingWriteContext) => Promise<T>): Promise<T> {
    if (!this.executor.transaction) throw new BillingError("billing_unavailable", 503);
    return this.executor.transaction(async (executor) => {
      // Try rather than wait: with REPEATABLE READ a waiting transaction may
      // retain a pre-commit snapshot. A busy caller retries from a fresh one.
      const result = await executor.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('rent-ops-recurring-billing'), hashtext($1)) AS locked", [month]);
      if (result.rows[0]?.locked !== true) throw new BillingError("billing_busy", 409);
      return work(this.context(executor));
    }, { readOnly: false });
  }
}
