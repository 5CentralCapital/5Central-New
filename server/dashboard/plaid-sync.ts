import type { BankAccount, BankTransaction } from "./types";

export interface PlaidSyncItem {
  readonly id: string;
  readonly access_token: string;
  readonly institution_name: string;
  readonly cursor: string | null;
}

export interface PlaidSyncDependencies {
  readonly client: {
    accountsBalanceGet(request: { access_token: string }): Promise<{ data: { accounts: any[] } }>;
    transactionsSync(request: { access_token: string; cursor?: string }): Promise<{ data: { added: any[]; modified: any[]; removed: any[]; next_cursor: string; has_more: boolean } }>;
  };
  upsertBankAccounts(plaidItemId: string, accounts: BankAccount[]): void;
  upsertTransactions(transactions: BankTransaction[]): void;
  removeTransactions(ids: string[]): void;
  updatePlaidItemSync(id: string, cursor: string | null, error: string | null): void;
}

/**
 * Sync one Plaid item: balances, then transactions from the stored cursor.
 * A failure keeps the last committed cursor so the next sync resumes from it;
 * resetting to null would restart from scratch and leave transactions Plaid
 * removed in the meantime (for example replaced pending ones) in the table.
 */
export async function syncPlaidItem(item: PlaidSyncItem, deps: PlaidSyncDependencies): Promise<void> {
  try {
    const balRes = await deps.client.accountsBalanceGet({ access_token: item.access_token });
    deps.upsertBankAccounts(
      item.id,
      balRes.data.accounts.map((a: any) => ({
        id: `ba_${a.account_id}`,
        plaidAccountId: a.account_id,
        name: a.name,
        officialName: a.official_name,
        type: a.type,
        subtype: a.subtype || a.type,
        mask: a.mask,
        currentBalance: a.balances.current || 0,
        availableBalance: a.balances.available,
        currency: a.balances.iso_currency_code || "USD",
        institution: item.institution_name,
      })),
    );
    let cursor: string | undefined = item.cursor || undefined;
    let hasMore = true;
    while (hasMore) {
      const txRes = await deps.client.transactionsSync({ access_token: item.access_token, cursor });
      const { added, modified, removed, next_cursor, has_more } = txRes.data;
      if (added.length || modified.length) {
        deps.upsertTransactions([...added, ...modified].map((t: any) => ({
          id: t.transaction_id,
          accountId: `ba_${t.account_id}`,
          date: t.date,
          name: t.name,
          amount: t.amount,
          category: t.category,
          merchantName: t.merchant_name,
          pending: t.pending,
        })));
      }
      if (removed.length) deps.removeTransactions(removed.map((r: any) => r.transaction_id));
      cursor = next_cursor;
      hasMore = has_more;
    }
    deps.updatePlaidItemSync(item.id, cursor || null, null);
  } catch (itemErr: any) {
    deps.updatePlaidItemSync(item.id, item.cursor ?? null, itemErr?.message || "Sync failed");
  }
}
