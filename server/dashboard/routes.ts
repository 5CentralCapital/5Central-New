import type { Express } from "express";
import { requireAdmin } from "../auth";
import { getDashboardData, updateTable, appendActivity } from "./db";
import { getBankingData } from "./bankingDb";

export function registerDashboardRoutes(app: Express) {
  // GET dashboard data
  app.get("/api/dashboard", requireAdmin, async (_req, res) => {
    try {
      const dashData = await getDashboardData();
      try {
        dashData.banking = getBankingData();
      } catch {}
      res.json(dashData);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // PATCH update a specific table
  app.patch("/api/dashboard", requireAdmin, async (req, res) => {
    try {
      const { table, data, reason } = req.body;
      if (!table || !data) {
        return res.status(400).json({ error: "table and data required" });
      }
      await updateTable(table, data);
      if (reason) {
        await appendActivity({
          actor: "admin",
          action: reason,
          entityType: table,
          entityId: "bulk",
          detail: `Updated ${table}`,
        });
      }
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Refresh (no-op — data is already live from PostgreSQL; frontend calls load() after)
  app.post("/api/dashboard/refresh", requireAdmin, (_req, res) => {
    res.json({ ok: true });
  });

  // Plaid routes (only if configured)
  app.post("/api/plaid/create-link-token", requireAdmin, async (_req, res) => {
    try {
      const { isPlaidConfigured, plaidClient, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } = await import("./plaid");
      if (!isPlaidConfigured()) {
        return res.status(400).json({ error: "Plaid not configured. Set PLAID_CLIENT_ID and PLAID_SECRET." });
      }
      const response = await plaidClient.linkTokenCreate({
        user: { client_user_id: "5cc-admin" },
        client_name: "5Central Capital",
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: "en",
      });
      res.json({ link_token: response.data.link_token });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/plaid/exchange-token", requireAdmin, async (req, res) => {
    try {
      const { isPlaidConfigured, plaidClient } = await import("./plaid");
      const { savePlaidItem } = await import("./bankingDb");
      if (!isPlaidConfigured()) {
        return res.status(400).json({ error: "Plaid not configured" });
      }
      const { public_token, institution } = req.body;
      const response = await plaidClient.itemPublicTokenExchange({ public_token });
      savePlaidItem({
        id: `pi_${Date.now()}`,
        itemId: response.data.item_id,
        accessToken: response.data.access_token,
        institutionName: institution?.name || "Unknown",
        institutionId: institution?.institution_id || null,
      });
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/plaid/sync", requireAdmin, async (_req, res) => {
    try {
      const { isPlaidConfigured, plaidClient } = await import("./plaid");
      const { getPlaidItems, upsertBankAccounts, upsertTransactions, removeTransactions, updatePlaidItemSync } = await import("./bankingDb");
      if (!isPlaidConfigured()) {
        return res.status(400).json({ error: "Plaid not configured" });
      }
      const items = getPlaidItems();
      for (const item of items) {
        try {
          // Sync balances — getPlaidItems returns snake_case fields
          const balRes = await plaidClient.accountsBalanceGet({ access_token: item.access_token });
          upsertBankAccounts(
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
            }))
          );
          // Sync transactions
          let cursor: string | undefined = item.cursor || undefined;
          let hasMore = true;
          while (hasMore) {
            const txRes = await plaidClient.transactionsSync({
              access_token: item.access_token,
              cursor,
            });
            const { added, modified, removed, next_cursor, has_more } = txRes.data;
            if (added.length || modified.length) {
              upsertTransactions(
                [...added, ...modified].map((t: any) => ({
                  id: t.transaction_id,
                  accountId: `ba_${t.account_id}`,
                  date: t.date,
                  name: t.name,
                  amount: t.amount,
                  category: t.category,
                  merchantName: t.merchant_name,
                  pending: t.pending,
                }))
              );
            }
            if (removed.length) {
              removeTransactions(removed.map((r: any) => r.transaction_id));
            }
            cursor = next_cursor;
            hasMore = has_more;
          }
          updatePlaidItemSync(item.id, cursor || null, null);
        } catch (itemErr: any) {
          updatePlaidItemSync(item.id, null, itemErr.message || "Sync failed");
        }
      }
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Ramp API routes ───
  app.get("/api/ramp/transactions", requireAdmin, async (req, res) => {
    try {
      const { isRampConfigured, fetchTransactions, buildSpendingSummary } = await import("./ramp");
      if (!isRampConfigured()) {
        return res.status(400).json({ error: "Ramp not configured. Set RAMP_CLIENT_ID and RAMP_CLIENT_SECRET." });
      }
      const fromDate = req.query.from_date as string | undefined;
      const toDate = req.query.to_date as string | undefined;
      const txs = await fetchTransactions({ fromDate, toDate });
      const summary = buildSpendingSummary(txs);
      res.json(summary);
    } catch (error: any) {
      console.error("Ramp sync error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/plaid/accounts", requireAdmin, (_req, res) => {
    try {
      const data = getBankingData();
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/plaid/disconnect", requireAdmin, async (req, res) => {
    try {
      const { deletePlaidItem } = await import("./bankingDb");
      const { itemId } = req.body;
      if (!itemId) return res.status(400).json({ error: "itemId required" });
      deletePlaidItem(itemId);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });
}
