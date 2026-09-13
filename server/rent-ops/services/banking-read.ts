import { createHash } from "node:crypto";
import type { BankingSnapshot } from "../../../shared/rent-ops-banking";

type Environment = Record<string, string | undefined>;
const opaque = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const money = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
const currency = (value: unknown) => typeof value === "string" && /^[A-Z]{3}$/.test(value) ? value : null;
const label = (value: unknown, fallback: string) => typeof value === "string" ? value.slice(0, 240) : fallback;
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

const timestamp = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Read-only bank evidence. Never creates ledger records or assigns an entity. */
export async function readBanking(env: Environment = process.env, request: typeof fetch = fetch, now = new Date()): Promise<BankingSnapshot> {
  const throughDate = now.toISOString().slice(0, 10);
  const from = new Date(now); from.setUTCDate(from.getUTCDate() - 29);
  const result: BankingSnapshot = { state: "unconfigured", fetchedAt: now.toISOString(), fromDate: from.toISOString().slice(0, 10), throughDate, connections: [] };
  const tokens = Array.from(new Set((env.PLAID_ACCESS_TOKENS || env.PLAID_ACCESS_TOKEN || "").split(",").map(value => value.trim()).filter(Boolean)));
  if (env.PLAID_ENV !== "production" || !env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !tokens.length) return result;
  async function call(endpoint: string, token: string, fields: Record<string, unknown> = {}) {
    const response = await request(`https://production.plaid.com/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" }, body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, access_token: token, ...fields }), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("bank_read_unavailable");
    return await response.json();
  }
  result.connections = await Promise.all(tokens.map(async (token, index) => {
    const id = opaque(token);
    const connection: BankingSnapshot["connections"][number] = { id, name: `Connection ${index + 1}`, balancesState: "unavailable", transactionsState: "unavailable", transactionsLastSuccessfulUpdate: null, transactionsLastFailedUpdate: null, accounts: [], transactions: [] };
    // Item status is independent of the balance and transaction reads; an outage here
    // must not discard usable bank data. Plaid returns status beside item, not inside it.
    const freshness = call("item/get", token).then(body => {
      connection.transactionsLastSuccessfulUpdate = timestamp(body.status?.transactions?.last_successful_update);
      connection.transactionsLastFailedUpdate = timestamp(body.status?.transactions?.last_failed_update);
    }).catch(() => { /* Freshness stays explicitly unknown. */ });
    const accountIds = new Map<string, string>();
    try {
      const body = await call("accounts/balance/get", token);
      if (!Array.isArray(body.accounts)) throw new Error("invalid_accounts");
      connection.accounts = body.accounts.map((account: any) => {
        if (typeof account.account_id !== "string") throw new Error("invalid_account");
        const accountId = opaque(`${id}:${account.account_id}`); accountIds.set(account.account_id, accountId);
        return { id: accountId, name: label(account.name, "Bank account"), mask: typeof account.mask === "string" && /^\d{2,4}$/.test(account.mask) ? account.mask : null, type: label(account.type, "Unknown"), currency: currency(account.balances?.iso_currency_code), currentCents: money(account.balances?.current), availableCents: money(account.balances?.available) };
      });
      connection.balancesState = "ready";
    } catch { /* Never return upstream errors or credentials. */ }
    try {
      // Independent of balance availability; preserve readable account labels on a balance outage.
      const transactions: BankingSnapshot["connections"][number]["transactions"] = [];
      let offset = 0;
      for (let page = 0; page < 10; page++) {
        const body = await call("transactions/get", token, { start_date: result.fromDate, end_date: throughDate, options: { count: 500, offset } });
        if (!Array.isArray(body.transactions) || !Number.isSafeInteger(body.total_transactions) || body.total_transactions < 0) throw new Error("invalid_transactions");
        for (const account of body.accounts ?? []) {
          if (typeof account.account_id !== "string" || accountIds.has(account.account_id)) continue;
          const accountId = opaque(`${id}:${account.account_id}`); accountIds.set(account.account_id, accountId);
          connection.accounts.push({ id: accountId, name: label(account.name, "Bank account"), mask: typeof account.mask === "string" && /^\d{2,4}$/.test(account.mask) ? account.mask : null, type: label(account.type, "Unknown"), currency: currency(account.balances?.iso_currency_code), currentCents: null, availableCents: null });
        }
        for (const tx of body.transactions) {
          const txDate = date(tx.date);
          if (!txDate || typeof tx.transaction_id !== "string" || typeof tx.account_id !== "string" || !accountIds.has(tx.account_id) || typeof tx.pending !== "boolean") throw new Error("invalid_transaction");
          if (txDate < result.fromDate || txDate > throughDate) continue;
          transactions.push({ id: opaque(`${id}:${tx.transaction_id}`), accountId: accountIds.get(tx.account_id)!, date: txDate, description: label(tx.merchant_name || tx.name, "Bank transaction"), amountCents: money(tx.amount), currency: currency(tx.iso_currency_code), pending: tx.pending });
        }
        offset += body.transactions.length;
        if (offset >= body.total_transactions) { connection.transactionsState = "ready"; break; }
        connection.transactionsState = "partial";
        if (!body.transactions.length) break;
      }
      connection.transactions = Array.from(new Map(transactions.map(tx => [tx.id, tx])).values()).sort((a, b) => b.date.localeCompare(a.date));
    } catch { connection.transactionsState = "unavailable"; connection.transactions = []; }
    await freshness;
    return connection;
  }));
  const allReady = result.connections.every(connection => connection.balancesState === "ready" && connection.transactionsState === "ready");
  const anyReady = result.connections.some(connection => connection.balancesState === "ready" || connection.transactionsState !== "unavailable");
  result.state = allReady ? "ready" : anyReady ? "partial" : "unavailable";
  return result;
}

/** Five-minute minimum refresh interval also applies to manual refreshes. */
export function createBankingReader(read: () => Promise<BankingSnapshot> = readBanking, clock: () => number = Date.now) {
  let cached: { expiresAt: number; value: BankingSnapshot } | undefined;
  let pending: Promise<BankingSnapshot> | undefined;
  return async () => {
    if (cached && cached.expiresAt > clock()) return cached.value;
    if (!pending) pending = read().then(value => { cached = { value, expiresAt: clock() + 300_000 }; return value; }).finally(() => { pending = undefined; });
    return pending;
  };
}
export const bankingRead = createBankingReader();
