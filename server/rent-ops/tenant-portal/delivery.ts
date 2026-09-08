import { ReplitConnectors } from "@replit/connectors-sdk";
import { createGmailTenantNotifier } from "./gmail-delivery";
export interface TenantAccessDelivery {
  issuanceId: string;
  accountId: string;
  email: string;
  token: string;
  expiresAt: string;
  purpose: "invitation" | "password_reset";
}
export type TenantAccessNotifier = (input: TenantAccessDelivery) => Promise<void>;
/** Acceptance means the receiver accepted responsibility, not mailbox delivery. */
export function createTenantAccessNotifier(env: Record<string,string|undefined> = process.env, fetchImpl: typeof fetch = fetch): TenantAccessNotifier | undefined {
  if (env.RENT_OPS_TENANT_EMAIL_ENABLED !== "true") return undefined;
  if (env.RENT_OPS_TENANT_EMAIL_PROVIDER === "replit-gmail") {
    const connector = new ReplitConnectors();
    // The official SDK manages Replit identity and provider authorization.
    // No Google access/refresh token is returned to or stored by this app.
    return createGmailTenantNotifier(env, connector.createProxyFetch("google-mail"), async () => "managed-proxy", true);
  }
  if (env.RENT_OPS_TENANT_EMAIL_PROVIDER === "gmail") return createGmailTenantNotifier(env, fetchImpl);
  const endpoint = new URL(env.RENT_OPS_MAGIC_LINK_WEBHOOK_URL ?? "");
  const app = new URL(env.RENT_OPS_PUBLIC_APP_URL ?? "");
  const secret = env.RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET ?? "";
  if (endpoint.protocol !== "https:" || app.protocol !== "https:" || endpoint.username || endpoint.password || app.username || app.password || secret.length < 16 || secret.length > 500) throw new Error("Tenant email configuration is invalid");
  return async input => {
    const response = await fetchImpl(endpoint, { method:"POST", signal:AbortSignal.timeout(10_000),
      headers:{"Content-Type":"application/json",Authorization:`Bearer ${secret}`,"Idempotency-Key":`rent-ops-tenant-access:${input.issuanceId}`},
      body:JSON.stringify({event:"tenant.access.v1",issuanceId:input.issuanceId,accountId:input.accountId,email:input.email,purpose:input.purpose,
        accessUrl:`${app.origin}/tenant#activate=${encodeURIComponent(input.token)}`,expiresAt:input.expiresAt}) });
    if (!response.ok) throw new Error("Tenant email was not accepted");
  };
}
