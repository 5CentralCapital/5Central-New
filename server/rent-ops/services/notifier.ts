import { createEmailRecipientPolicy } from "../email/recipient-policy";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { createHash } from "node:crypto";
import { createGmailTenantNotifier } from "../tenant-portal/gmail-delivery";
export interface MagicLinkDeliveryInput {
  applicationId: string;
  email: string;
  token: string;
  expiresAt: string;
}

export interface MagicLinkWebhookConfig {
  webhookUrl: string;
  webhookSecret: string;
  publicAppUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  allowedRecipients?: string;
}

export type MagicLinkNotifier = (input: MagicLinkDeliveryInput) => Promise<void>;

/** Provider/network failures are typed so the HTTP layer can stay generic. */
export class MagicLinkDeliveryError extends Error {
  readonly code = "MAGIC_LINK_DELIVERY_FAILED";

  constructor(message = "Magic-link delivery failed", options?: { cause?: unknown }) {
    super(message);
    this.name = "MagicLinkDeliveryError";
    if (options?.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

export const DEFAULT_MAGIC_LINK_DELIVERY_TIMEOUT_MS = 10_000;

function httpsUrl(value: string, label: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid HTTPS URL`); }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return parsed;
}

/**
 * Creates the provider-neutral delivery adapter. It never reads dotenv or a
 * database and never logs the token. An entirely absent configuration returns
 * undefined so public application start remains intentionally disabled.
 */
export function createMagicLinkWebhookNotifier(config: MagicLinkWebhookConfig): MagicLinkNotifier {
  const recipient = createEmailRecipientPolicy(config.allowedRecipients);
  const webhookUrl = httpsUrl(config.webhookUrl, "RENT_OPS_MAGIC_LINK_WEBHOOK_URL").toString();
  const publicAppUrl = httpsUrl(config.publicAppUrl, "RENT_OPS_PUBLIC_APP_URL").toString().replace(/\/$/, "");
  if (config.webhookSecret.trim().length < 16 || config.webhookSecret.length > 500) throw new Error("RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET must be 16-500 characters");
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_MAGIC_LINK_DELIVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("Magic-link delivery timeout must be an integer from 100 to 120000 milliseconds");
  return async ({ applicationId, email, token, expiresAt }) => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      email = recipient(email);
      const request = fetchImpl(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.webhookSecret}`,
          // The application id is stable across safe retries and contains no
          // credential, so a provider can de-duplicate delivery attempts.
          "Idempotency-Key": `rent-ops-application:${applicationId}`,
        },
        signal: controller.signal,
        // URL fragments are never sent in the HTTP request line, so reverse
        // proxies and ordinary access logs cannot capture the resume token.
        body: JSON.stringify({ applicationId, email, resumeUrl: `${publicAppUrl}/apply#resume=${encodeURIComponent(token)}`, expiresAt }),
      });
      const response = await new Promise<Response>((resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new MagicLinkDeliveryError("Magic-link delivery timed out"));
        }, timeoutMs);
        request.then(resolve, reject);
      });
      if (!response.ok) throw new MagicLinkDeliveryError("Magic-link delivery provider rejected the request");
    } catch (error) {
      if (error instanceof MagicLinkDeliveryError) throw error;
      throw new MagicLinkDeliveryError("Magic-link delivery failed", { cause: error });
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    }
  };
}

export function createMagicLinkWebhookNotifierFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): MagicLinkNotifier | undefined {
  createEmailRecipientPolicy(env.RENT_OPS_EMAIL_ALLOWED_RECIPIENTS);
  const provider = env.RENT_OPS_TENANT_EMAIL_PROVIDER;
  if (provider === "gmail" || provider === "replit-gmail") {
    if (env.RENT_OPS_TENANT_EMAIL_ENABLED !== "true") return undefined;
    const managed = provider === "replit-gmail";
    const send = createGmailTenantNotifier(env, fetchImpl ?? (managed ? new ReplitConnectors().createProxyFetch("google-mail") : fetch), managed ? async () => "managed-proxy" : undefined, managed);
    return async input => {
      try { await send({ ...input, accountId: input.applicationId,
        issuanceId: createHash("sha256").update(input.applicationId + ":" + input.token).digest("hex"), purpose: "application_resume" }); }
      catch { throw new MagicLinkDeliveryError("Application email could not be confirmed"); }
    };
  }
  const webhookUrl = env.RENT_OPS_MAGIC_LINK_WEBHOOK_URL;
  const webhookSecret = env.RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET;
  const publicAppUrl = env.RENT_OPS_PUBLIC_APP_URL;
  if (!webhookUrl && !webhookSecret && !publicAppUrl) return undefined;
  if (!webhookUrl || !webhookSecret || !publicAppUrl) throw new Error("Magic-link webhook configuration requires URL, secret, and public application URL");
  return createMagicLinkWebhookNotifier({ webhookUrl, webhookSecret, publicAppUrl, fetchImpl, allowedRecipients: env.RENT_OPS_EMAIL_ALLOWED_RECIPIENTS });
}
