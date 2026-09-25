import express, { type Express } from "express";
import type { QboEnvironment } from "../../shared/accounting/operations";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { ingestQuickBooksWebhookDelivery } from "./webhook-ingest";

export const QBO_WEBHOOK_PATH = "/api/integrations/quickbooks/webhook/:environment";

/** Each Intuit environment signs with its own verifier token. */
export function qboWebhookVerifierToken(environment: QboEnvironment, env: NodeJS.ProcessEnv = process.env): string | null {
  const value = environment === "production" ? env.QBO_WEBHOOK_VERIFIER_TOKEN_PRODUCTION : env.QBO_WEBHOOK_VERIFIER_TOKEN_SANDBOX;
  return typeof value === "string" && value.length >= 8 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

/**
 * Register before express.json(): the HMAC covers the exact request bytes.
 * The handler verifies, records and enqueues, then answers 200 without any
 * provider call. A bad signature is rejected with 401 and nothing is stored.
 */
export function registerQuickBooksWebhookRoute(app: Express, options: { readonly getExecutor: () => RentOpsQueryExecutor | undefined; readonly env?: NodeJS.ProcessEnv }): void {
  app.post(QBO_WEBHOOK_PATH, express.raw({ type: () => true, limit: "1mb" }), async (request, response) => {
    response.set("Cache-Control", "no-store");
    const environment = request.params.environment;
    if (environment !== "sandbox" && environment !== "production") { response.status(404).json({ code: "qbo_webhook_unknown_environment" }); return; }
    const verifierToken = qboWebhookVerifierToken(environment, options.env ?? process.env);
    const executor = options.getExecutor();
    if (!verifierToken || !executor) { response.status(503).json({ code: "qbo_webhook_unavailable" }); return; }
    if (!Buffer.isBuffer(request.body)) { response.status(400).json({ code: "qbo_webhook_invalid" }); return; }
    try {
      const result = await ingestQuickBooksWebhookDelivery({ executor, environment, rawBody: request.body, signature: request.get("intuit-signature") ?? undefined, verifierToken });
      if (result.status === "rejected") {
        response.status(result.reason === "signature" ? 401 : 400).json({ code: result.reason === "signature" ? "qbo_webhook_signature" : "qbo_webhook_invalid" });
        return;
      }
      response.status(200).json({ received: result.received, accepted: result.fresh });
    } catch {
      // Intuit retries non-2xx deliveries; nothing partial was committed.
      response.status(503).json({ code: "qbo_webhook_unavailable" });
    }
  });
}
