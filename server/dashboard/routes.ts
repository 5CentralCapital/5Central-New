import type { Express } from "express";
import { requireAdmin, requireAdminOrApiKey } from "../auth";
import {
  getDashboardData,
  updateTable,
  appendActivity,
  getTasks,
  addTask,
  updateTask,
  deleteTask,
  getMetrics,
  replaceMetrics,
  getDashboardSummary,
} from "./db";
import { getBankingData } from "./bankingDb";

export function registerDashboardRoutes(app: Express) {
  // GET dashboard data (session OR API key)
  app.get("/api/dashboard", requireAdminOrApiKey, async (_req, res) => {
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

  // PATCH update a specific table (session OR API key)
  app.patch("/api/dashboard", requireAdminOrApiKey, async (req, res) => {
    try {
      const { table, data, reason } = req.body;
      if (!table || !data) {
        return res.status(400).json({ error: "table and data required" });
      }
      await updateTable(table, data);
      const actor = (req as any).apiKeyAuth ? "openclaw" : "admin";
      if (reason) {
        await appendActivity({
          actor,
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

  // Refresh — returns fresh dashboard data (useful for validation after PATCH)
  app.post("/api/dashboard/refresh", requireAdminOrApiKey, async (_req, res) => {
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

  // ─── Quick summary endpoint (totals only, lightweight) ───
  app.get("/api/dashboard/summary", requireAdminOrApiKey, async (_req, res) => {
    try {
      const summary = await getDashboardSummary();
      res.json(summary);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Standalone task endpoints (session OR API key) ───

  app.get("/api/tasks", requireAdminOrApiKey, async (_req, res) => {
    try {
      const tasks = await getTasks();
      res.json(tasks);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/tasks", requireAdminOrApiKey, async (req, res) => {
    try {
      const id = await addTask(req.body);
      const actor = (req as any).apiKeyAuth ? "openclaw" : "admin";
      await appendActivity({
        actor,
        action: "add_task",
        entityType: "tasks",
        entityId: id,
        detail: `Added task: ${req.body.title}`,
      });
      res.json({ ok: true, id });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/tasks/:id", requireAdminOrApiKey, async (req, res) => {
    try {
      await updateTask(req.params.id, req.body);
      const actor = (req as any).apiKeyAuth ? "openclaw" : "admin";
      await appendActivity({
        actor,
        action: "update_task",
        entityType: "tasks",
        entityId: req.params.id,
        detail: `Updated task ${req.params.id}`,
      });
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/tasks/:id", requireAdminOrApiKey, async (req, res) => {
    try {
      await deleteTask(req.params.id);
      const actor = (req as any).apiKeyAuth ? "openclaw" : "admin";
      await appendActivity({
        actor,
        action: "delete_task",
        entityType: "tasks",
        entityId: req.params.id,
        detail: `Deleted task ${req.params.id}`,
      });
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Standalone metrics endpoints (session OR API key) ───

  app.get("/api/metrics", requireAdminOrApiKey, async (_req, res) => {
    try {
      const metrics = await getMetrics();
      res.json(metrics);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put("/api/metrics", requireAdminOrApiKey, async (req, res) => {
    try {
      await replaceMetrics(req.body);
      const actor = (req as any).apiKeyAuth ? "openclaw" : "admin";
      await appendActivity({
        actor,
        action: "replace_metrics",
        entityType: "metrics",
        entityId: "bulk",
        detail: `Replaced all metrics (${req.body.length} records)`,
      });
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ─── Standalone activity endpoint (session OR API key) ───

  app.post("/api/activity", requireAdminOrApiKey, async (req, res) => {
    try {
      const actor = (req as any).apiKeyAuth ? "openclaw" : (req.body.actor || "admin");
      await appendActivity({
        actor,
        action: req.body.action || "log",
        entityType: req.body.entityType || "system",
        entityId: req.body.entityId || "manual",
        detail: req.body.detail || "",
      });
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
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

  // ─── Rent Manager API routes ───

  app.get("/api/rm/properties", requireAdmin, async (_req, res) => {
    try {
      const { isRMConfigured, fetchRMProperties } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured. Set RM_USERNAME and RM_PASSWORD in .env." });
      }
      const properties = await fetchRMProperties();
      res.json(properties);
    } catch (error: any) {
      console.error("RM properties error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rm/tenants", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, fetchRMTenants } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const propertyId = req.query.propertyId as string | undefined;
      const status = req.query.status as string | undefined;
      const tenants = await fetchRMTenants(propertyId, status || undefined);
      res.json(tenants);
    } catch (error: any) {
      console.error("RM tenants error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rm/units", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, fetchRMUnits } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const propertyId = req.query.propertyId as string;
      if (!propertyId) return res.status(400).json({ error: "propertyId is required" });
      const units = await fetchRMUnits(propertyId);
      res.json(units);
    } catch (error: any) {
      console.error("RM units error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rm/rent-roll", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, buildRentRoll } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const propertyId = req.query.propertyId as string;
      if (!propertyId) return res.status(400).json({ error: "propertyId is required" });
      const rentRoll = await buildRentRoll(propertyId);
      res.json(rentRoll);
    } catch (error: any) {
      console.error("RM rent roll error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rm/charges", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, fetchRMCharges } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const charges = await fetchRMCharges({
        tenantId: req.query.tenantId as string | undefined,
        propertyId: req.query.propertyId as string | undefined,
        fromDate: req.query.fromDate as string | undefined,
        toDate: req.query.toDate as string | undefined,
      });
      res.json(charges);
    } catch (error: any) {
      console.error("RM charges error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rm/payments", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, fetchRMPayments } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const payments = await fetchRMPayments({
        tenantId: req.query.tenantId as string | undefined,
        fromDate: req.query.fromDate as string | undefined,
        toDate: req.query.toDate as string | undefined,
      });
      res.json(payments);
    } catch (error: any) {
      console.error("RM payments error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rm/recurring-charges", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, fetchRMRecurringCharges } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const charges = await fetchRMRecurringCharges({
        tenantId: req.query.tenantId as string | undefined,
      });
      res.json(charges);
    } catch (error: any) {
      console.error("RM recurring charges error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rm/leases", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, fetchRMLeases } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const leases = await fetchRMLeases({
        tenantId: req.query.tenantId as string | undefined,
        propertyId: req.query.propertyId as string | undefined,
      });
      res.json(leases);
    } catch (error: any) {
      console.error("RM leases error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/rm/work-orders", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, fetchRMServiceIssues } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const issues = await fetchRMServiceIssues({
        propertyId: req.query.propertyId as string | undefined,
        status: req.query.status as string | undefined,
      });
      res.json(issues);
    } catch (error: any) {
      console.error("RM work orders error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vacancy report — all vacant units across properties with lost rent
  app.get("/api/rm/vacancies", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, buildVacancyReport } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const propertyId = req.query.propertyId as string | undefined;
      const propertyIds = propertyId ? [propertyId] : undefined;
      const report = await buildVacancyReport(propertyIds);
      res.json(report);
    } catch (error: any) {
      console.error("RM vacancies error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Monthly rent summary (charges + payments grouped by month) for P&L overlay
  app.get("/api/rm/monthly-rent", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, buildMonthlyRentSummary } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const propertyId = req.query.propertyId as string;
      const fromDate = req.query.fromDate as string;
      const toDate = req.query.toDate as string;
      if (!propertyId || !fromDate || !toDate) {
        return res.status(400).json({ error: "propertyId, fromDate, toDate are required" });
      }
      const summary = await buildMonthlyRentSummary(propertyId, fromDate, toDate);
      res.json(summary);
    } catch (error: any) {
      console.error("RM monthly rent error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Generic RM API passthrough for flexibility
  app.get("/api/rm/raw/:resource", requireAdmin, async (req, res) => {
    try {
      const { isRMConfigured, rmGet } = await import("./rentmanager");
      if (!isRMConfigured()) {
        return res.status(400).json({ error: "Rent Manager not configured." });
      }
      const { resource } = req.params;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") params[k] = v;
      }
      const data = await rmGet(`/${resource}`, params);
      res.json(data);
    } catch (error: any) {
      console.error("RM raw API error:", error);
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
