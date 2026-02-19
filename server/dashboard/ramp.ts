/**
 * Ramp API integration for tracking corporate card expenses.
 * Used primarily to pull rehab/renovation spending by property.
 *
 * Auth: OAuth2 Client Credentials → Bearer token
 * Base URL: https://api.ramp.com/developer/v1
 * Rate limit: 100 requests/minute
 */

const RAMP_BASE = "https://api.ramp.com/developer/v1";

let cachedToken: { token: string; expiresAt: number } | null = null;

export function isRampConfigured(): boolean {
  return !!(process.env.RAMP_CLIENT_ID && process.env.RAMP_CLIENT_SECRET);
}

/** Get a Bearer token using client credentials grant. Tokens last ~10 days. */
async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 1hr buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 3600_000) {
    return cachedToken.token;
  }

  const clientId = process.env.RAMP_CLIENT_ID!;
  const clientSecret = process.env.RAMP_CLIENT_SECRET!;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(`${RAMP_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=transactions:read",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ramp auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 864000) * 1000,
  };
  return cachedToken.token;
}

/** Make an authenticated GET request to the Ramp API. */
async function rampGet(path: string, params?: Record<string, string>): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(`${RAMP_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ramp API error (${res.status}): ${text}`);
  }

  return res.json();
}

/** Ramp transaction object (simplified to fields we care about). */
export interface RampTransaction {
  id: string;
  amount: number;
  merchant_id: string;
  merchant_name: string;
  sk_category_name: string;
  card_holder?: { first_name: string; last_name: string };
  memo: string | null;
  state: string;
  user_transaction_time: string | null;
  accounting_categories?: { category_id: string; category_name: string }[];
}

export interface RampSpendingSummary {
  totalSpent: number;
  transactionCount: number;
  byMerchant: { merchant: string; total: number; count: number }[];
  byCategory: { category: string; total: number; count: number }[];
  recentTransactions: {
    id: string;
    date: string;
    merchant: string;
    amount: number;
    category: string;
    memo: string | null;
    state: string;
    cardHolder: string;
  }[];
}

/**
 * Fetch transactions from Ramp with optional date filtering.
 * Paginates automatically (up to 5 pages / 5000 transactions).
 */
export async function fetchTransactions(opts?: {
  fromDate?: string;
  toDate?: string;
  pageSize?: number;
  maxPages?: number;
}): Promise<RampTransaction[]> {
  const allTxs: RampTransaction[] = [];
  const pageSize = opts?.pageSize || 100;
  const maxPages = opts?.maxPages || 50;
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const params: Record<string, string> = {
      page_size: String(pageSize),
      order_by_date_desc: "true",
    };
    if (opts?.fromDate) params.from_date = opts.fromDate;
    if (opts?.toDate) params.to_date = opts.toDate;
    if (cursor) params.start = cursor;

    const data = await rampGet("/transactions", params);
    const txs: RampTransaction[] = data.data || [];
    allTxs.push(...txs);

    // Cursor-based pagination: if fewer results than page_size, we're done
    if (txs.length < pageSize) break;
    // Use last transaction ID as cursor
    cursor = txs[txs.length - 1]?.id;
    if (!cursor) break;
  }

  return allTxs;
}

/**
 * Build a spending summary from raw transactions.
 * Groups by merchant and by Ramp's built-in spending category.
 */
export function buildSpendingSummary(transactions: RampTransaction[]): RampSpendingSummary {
  // Only count cleared/settled transactions (positive amounts = charges)
  const cleared = transactions.filter((t) => t.amount > 0);

  const totalSpent = cleared.reduce((s, t) => s + t.amount, 0);

  // Group by merchant
  const merchantMap = new Map<string, { total: number; count: number }>();
  for (const t of cleared) {
    const name = t.merchant_name || "Unknown";
    const existing = merchantMap.get(name) || { total: 0, count: 0 };
    existing.total += t.amount;
    existing.count++;
    merchantMap.set(name, existing);
  }
  const byMerchant = Array.from(merchantMap.entries())
    .map(([merchant, data]) => ({ merchant, ...data }))
    .sort((a, b) => b.total - a.total);

  // Group by category
  const categoryMap = new Map<string, { total: number; count: number }>();
  for (const t of cleared) {
    const cat = t.sk_category_name || "Uncategorized";
    const existing = categoryMap.get(cat) || { total: 0, count: 0 };
    existing.total += t.amount;
    existing.count++;
    categoryMap.set(cat, existing);
  }
  const byCategory = Array.from(categoryMap.entries())
    .map(([category, data]) => ({ category, ...data }))
    .sort((a, b) => b.total - a.total);

  // Recent transactions (most recent 50)
  const recentTransactions = transactions.slice(0, 50).map((t) => ({
    id: t.id,
    date: t.user_transaction_time?.split("T")[0] || "unknown",
    merchant: t.merchant_name || t.merchant_id || "Unknown",
    amount: t.amount,
    category: t.sk_category_name || "Uncategorized",
    memo: t.memo,
    state: t.state,
    cardHolder: t.card_holder
      ? `${t.card_holder.first_name} ${t.card_holder.last_name}`
      : "Unknown",
  }));

  return {
    totalSpent,
    transactionCount: cleared.length,
    byMerchant,
    byCategory,
    recentTransactions,
  };
}
