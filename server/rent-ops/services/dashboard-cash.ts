import type { DashboardCash } from "../../../shared/rent-ops-dashboard";

type CashEnvironment = Record<string, string | undefined>;

/** The cash account belongs to the company. Never allocate it across properties.
 * Secrets remain server-side; the response is a positive, account-limited DTO. */
export async function readDashboardCash(env: CashEnvironment = process.env, request: typeof fetch = fetch): Promise<DashboardCash> {
  const tokens = (env.PLAID_ACCESS_TOKENS || env.PLAID_ACCESS_TOKEN || "").split(",").map(value => value.trim()).filter(Boolean);
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !tokens.length || env.PLAID_ENV !== "production") return { state: "unconfigured" };
  const mask = env.RENT_OPS_CASH_ACCOUNT_MASK || "7772";
  if (!/^\d{4}$/.test(mask)) return { state: "unavailable" };
  try {
    const results = await Promise.all(tokens.map(async access_token => {
      const response = await request("https://production.plaid.com/accounts/balance/get", {
        method: "POST", headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
        body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, access_token }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const body = await response.json() as { accounts?: Array<{ account_id: string; name: string; mask: string; type: string; balances: { current: number | null; available: number | null; iso_currency_code: string | null } }> };
      return (body.accounts ?? []).filter(account => account.mask === mask && account.type === "depository" && account.balances.iso_currency_code === "USD");
    }));
    const accounts = Array.from(new Map(results.flat().map(account => [account.account_id, account])).values());
    if (accounts.length !== 1) return { state: "unavailable" };
    const account = accounts[0];
    const cents = (value: number | null) => typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100)) ? Math.round(value * 100) : null;
    return { state: "ready", name: account.name, mask, currentCents: cents(account.balances.current), availableCents: cents(account.balances.available), currency: "USD", checkedAt: new Date().toISOString() };
  } catch { return { state: "unavailable" }; }
}

let cached: { expiresAt: number; value: DashboardCash } | undefined;
let pending: Promise<DashboardCash> | undefined;
export async function dashboardCash(): Promise<DashboardCash> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!pending) pending = readDashboardCash().then(value => { cached = { value, expiresAt: Date.now() + 60_000 }; return value; }).finally(() => { pending = undefined; });
  return pending;
}
