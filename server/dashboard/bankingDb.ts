import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { BankAccount, BankTransaction, PlaidConnection } from "./types";

const dbPath = path.join(process.cwd(), "data", "banking.db");
let db: Database.Database;

function initBankingDb() {
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS plaid_items (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      item_id TEXT NOT NULL,
      institution_name TEXT,
      institution_id TEXT,
      status TEXT DEFAULT 'active',
      cursor TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_synced_at TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS bank_accounts (
      id TEXT PRIMARY KEY,
      plaid_item_id TEXT NOT NULL,
      plaid_account_id TEXT NOT NULL,
      name TEXT,
      official_name TEXT,
      type TEXT,
      subtype TEXT,
      mask TEXT,
      current_balance REAL DEFAULT 0,
      available_balance REAL,
      currency TEXT DEFAULT 'USD',
      last_synced_at TEXT,
      FOREIGN KEY (plaid_item_id) REFERENCES plaid_items(id)
    );

    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      plaid_transaction_id TEXT UNIQUE,
      date TEXT,
      name TEXT,
      amount REAL,
      category TEXT,
      merchant_name TEXT,
      pending INTEGER DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES bank_accounts(id)
    );
  `);
}
initBankingDb();

/* ── Plaid Items (connections) ── */

export function savePlaidItem(item: {
  id: string;
  accessToken: string;
  itemId: string;
  institutionName?: string;
  institutionId?: string;
}) {
  db.prepare(`INSERT INTO plaid_items (id, access_token, item_id, institution_name, institution_id)
    VALUES (@id, @accessToken, @itemId, @institutionName, @institutionId)
    ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token, institution_name=excluded.institution_name`).run({
    id: item.id,
    accessToken: item.accessToken,
    itemId: item.itemId,
    institutionName: item.institutionName || null,
    institutionId: item.institutionId || null,
  });
}

export function getPlaidItems(): { id: string; access_token: string; item_id: string; institution_name: string; institution_id: string; status: string; cursor: string | null; last_synced_at: string | null; error: string | null }[] {
  return db.prepare("SELECT * FROM plaid_items").all() as any[];
}

export function updatePlaidItemSync(id: string, cursor: string | null, error: string | null) {
  db.prepare("UPDATE plaid_items SET last_synced_at = datetime('now'), cursor = ?, error = ?, status = ? WHERE id = ?").run(
    cursor, error, error ? "error" : "active", id
  );
}

export function deletePlaidItem(id: string) {
  db.prepare("DELETE FROM bank_transactions WHERE account_id IN (SELECT id FROM bank_accounts WHERE plaid_item_id = ?)").run(id);
  db.prepare("DELETE FROM bank_accounts WHERE plaid_item_id = ?").run(id);
  db.prepare("DELETE FROM plaid_items WHERE id = ?").run(id);
}

/* ── Accounts ── */

export function upsertBankAccounts(plaidItemId: string, accounts: BankAccount[]) {
  const stmt = db.prepare(`INSERT INTO bank_accounts (id, plaid_item_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, currency, last_synced_at)
    VALUES (@id, @plaidItemId, @plaidAccountId, @name, @officialName, @type, @subtype, @mask, @currentBalance, @availableBalance, @currency, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, current_balance=excluded.current_balance, available_balance=excluded.available_balance, last_synced_at=excluded.last_synced_at`);

  const tx = db.transaction(() => {
    for (const a of accounts) {
      stmt.run({
        id: a.id,
        plaidItemId,
        plaidAccountId: a.plaidAccountId,
        name: a.name,
        officialName: a.officialName || null,
        type: a.type,
        subtype: a.subtype,
        mask: a.mask || null,
        currentBalance: a.currentBalance,
        availableBalance: a.availableBalance ?? null,
        currency: a.currency,
      });
    }
  });
  tx();
}

export function getBankAccounts(): BankAccount[] {
  const rows = db.prepare(`SELECT ba.*, pi.institution_name as institution
    FROM bank_accounts ba
    JOIN plaid_items pi ON ba.plaid_item_id = pi.id
    ORDER BY ba.current_balance DESC`).all() as any[];

  return rows.map((r) => ({
    id: r.id,
    plaidAccountId: r.plaid_account_id,
    name: r.name,
    officialName: r.official_name,
    type: r.type,
    subtype: r.subtype,
    mask: r.mask,
    currentBalance: r.current_balance,
    availableBalance: r.available_balance,
    currency: r.currency,
    institution: r.institution,
    lastSynced: r.last_synced_at,
  }));
}

/* ── Transactions ── */

export function upsertTransactions(transactions: BankTransaction[]) {
  const stmt = db.prepare(`INSERT INTO bank_transactions (id, account_id, plaid_transaction_id, date, name, amount, category, merchant_name, pending)
    VALUES (@id, @accountId, @plaidTxId, @date, @name, @amount, @category, @merchantName, @pending)
    ON CONFLICT(plaid_transaction_id) DO UPDATE SET name=excluded.name, amount=excluded.amount, pending=excluded.pending, date=excluded.date`);

  const tx = db.transaction(() => {
    for (const t of transactions) {
      stmt.run({
        id: t.id,
        accountId: t.accountId,
        plaidTxId: t.id,
        date: t.date,
        name: t.name,
        amount: t.amount,
        category: t.category ? JSON.stringify(t.category) : null,
        merchantName: t.merchantName || null,
        pending: t.pending ? 1 : 0,
      });
    }
  });
  tx();
}

export function removeTransactions(ids: string[]) {
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM bank_transactions WHERE plaid_transaction_id IN (${placeholders})`).run(...ids);
}

export function getRecentTransactions(limit = 50): BankTransaction[] {
  const rows = db.prepare(`SELECT * FROM bank_transactions ORDER BY date DESC, id DESC LIMIT ?`).all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    date: r.date,
    name: r.name,
    amount: r.amount,
    category: r.category ? JSON.parse(r.category) : undefined,
    merchantName: r.merchant_name,
    pending: !!r.pending,
  }));
}

/* ── Connections summary ── */

export function getConnections(): PlaidConnection[] {
  const items = getPlaidItems();
  return items.map((item) => {
    const accountCount = (db.prepare("SELECT COUNT(*) as c FROM bank_accounts WHERE plaid_item_id = ?").get(item.id) as any)?.c || 0;
    return {
      id: item.id,
      institutionName: item.institution_name || "Unknown",
      institutionId: item.institution_id,
      status: item.error ? "error" : "active",
      lastSynced: item.last_synced_at || undefined,
      accountCount,
      error: item.error || undefined,
    } as PlaidConnection;
  });
}

/* ── Aggregated banking data for dashboard ── */

export function getBankingData() {
  const accounts = getBankAccounts();
  const recentTransactions = getRecentTransactions(30);
  const connections = getConnections();
  const totalCash = accounts
    .filter((a) => a.type === "depository")
    .reduce((sum, a) => sum + a.currentBalance, 0);

  return { accounts, recentTransactions, connections, totalCash };
}
