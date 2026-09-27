import type { Express, Request, RequestHandler } from "express";
import type { TenantIdentity } from "../../../shared/tenant-portal-contracts";
import { qboTenantPaymentLinkSchema, type QboTenantPaymentView, type QboTenantPaymentLink } from "../../../shared/tenant-qbo-payment-contracts";

export interface TenantQuickBooksPayments {
  list(identity: TenantIdentity): Promise<QboTenantPaymentView>;
  link(identity: TenantIdentity, invoiceId: string): Promise<QboTenantPaymentLink>;
}

export function registerTenantQuickBooksPaymentRoutes(app: Express, options: {
  service: TenantQuickBooksPayments;
  requireTenant: RequestHandler;
  getTenantIdentity: (req: Request) => TenantIdentity | undefined;
}) {
  // requireTenant validates the active account, exact binding and POST CSRF.
  app.get("/api/tenant/payments/quickbooks", options.requireTenant, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const identity = options.getTenantIdentity(req);
    if (!identity) { res.status(401).json({ error: "tenant_authentication_required" }); return; }
    try { res.json(await options.service.list(identity)); }
    catch { res.status(503).json({ error: "quickbooks_payments_unavailable" }); }
  });
  app.post("/api/tenant/payments/quickbooks/link", options.requireTenant, async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    const identity = options.getTenantIdentity(req);
    if (!identity) { res.status(401).json({ error: "tenant_authentication_required" }); return; }
    const input = qboTenantPaymentLinkSchema.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: "invalid_invoice_request" }); return; }
    // No caller-supplied tenancy, customer, company, email, amount or URL.
    try { res.json(await options.service.link(identity, input.data.invoiceId)); }
    catch { res.status(503).json({ error: "quickbooks_payments_unavailable" }); }
  });
}
