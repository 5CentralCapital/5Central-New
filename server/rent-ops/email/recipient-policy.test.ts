import assert from "node:assert/strict";
import test from "node:test";
import { createEmailRecipientPolicy } from "./recipient-policy";
import { createTenantAccessNotifier } from "../tenant-portal/delivery";
import { createGmailTenantNotifier } from "../tenant-portal/gmail-delivery";
import { createMagicLinkWebhookNotifier, createMagicLinkWebhookNotifierFromEnv } from "../services/notifier";

const base = { RENT_OPS_TENANT_EMAIL_ENABLED: "true", RENT_OPS_PUBLIC_APP_URL: "https://portal.example.test", RENT_OPS_MAGIC_LINK_WEBHOOK_URL: "https://delivery.example.test", RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET: "synthetic-secret-1234", RENT_OPS_GMAIL_FROM: "sender@example.test", RENT_OPS_GMAIL_CLIENT_ID: "synthetic", RENT_OPS_GMAIL_CLIENT_SECRET: "synthetic", RENT_OPS_GMAIL_REFRESH_TOKEN: "synthetic" };
const input = { issuanceId: "qa-issue", accountId: "qa", applicationId: "qa", email: "qa@example.test", token: "a".repeat(43), expiresAt: "2026-09-10T00:00:00Z", purpose: "invitation" as const };

test("recipient restriction rejects missing lists, malformed lists, and header/multiple-recipient injection", () => {
  assert.throws(() => createEmailRecipientPolicy(undefined)(input.email), /not_allowed/);
  for (const bad of ["", " ", "*", "qa@example.test,", "qa@example.test\n", "Name <qa@example.test>"]) assert.throws(() => createEmailRecipientPolicy(bad), /allowlist_invalid/);
  const allow = createEmailRecipientPolicy(" QA@example.test , second@example.test ");
  assert.equal(allow("QA@EXAMPLE.TEST"), input.email);
  for (const bad of ["real@example.test", "qa@example.test,real@example.test", "qa@example.test\r\nBcc: real@example.test", "qa+real@example.test"]) assert.throws(() => allow(bad));
});

for (const transport of ["tenant-webhook", "application-webhook", "gmail-refresh", "gmail-managed", "application-gmail"] as const) {
  test(`${transport} denies unlisted and missing-list recipients before any provider access`, async () => {
    for (const configured of [undefined, input.email]) {
      let calls = 0;
      const fakeFetch: typeof fetch = async () => { calls++; return Response.json({ id: "accepted", access_token: "synthetic" }); };
      const env = { ...base, RENT_OPS_EMAIL_ALLOWED_RECIPIENTS: configured };
      const notify = transport === "tenant-webhook" ? createTenantAccessNotifier(env, fakeFetch)!
        : transport === "application-webhook" ? createMagicLinkWebhookNotifier({webhookUrl:base.RENT_OPS_MAGIC_LINK_WEBHOOK_URL,webhookSecret:base.RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET,publicAppUrl:base.RENT_OPS_PUBLIC_APP_URL,allowedRecipients:configured,fetchImpl:fakeFetch})
        : transport === "gmail-refresh" ? createGmailTenantNotifier(env, fakeFetch)
        : transport === "gmail-managed" ? createGmailTenantNotifier(env, fakeFetch, async () => { calls++; return "managed"; }, true)
        : createMagicLinkWebhookNotifierFromEnv({...env,RENT_OPS_TENANT_EMAIL_PROVIDER:"replit-gmail"},fakeFetch)!;
      await assert.rejects(notify({...input,email:"real@example.test"}));
      assert.equal(calls, 0);
      if (configured) { await notify(input); assert.ok(calls > 0); }
      else { await assert.rejects(notify(input)); assert.equal(calls,0); }
    }
  });
}
