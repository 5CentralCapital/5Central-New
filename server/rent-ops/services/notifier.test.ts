import assert from "node:assert/strict";
import test from "node:test";
import { createMagicLinkWebhookNotifier, createMagicLinkWebhookNotifierFromEnv, MagicLinkDeliveryError } from "./notifier";

test("magic-link webhook sends only the delivery contract and keeps the secret out of the body", async () => {
  let call: { url: string; init?: RequestInit } | undefined;
  const notifier = createMagicLinkWebhookNotifier({ webhookUrl: "https://notify.example.test/hook", webhookSecret: "synthetic-secret-1234", publicAppUrl: "https://apply.example.test", fetchImpl: async (url, init) => { call = { url: String(url), init }; return new Response("ok", { status: 202 }); } });
  await notifier({ applicationId: "application:1", email: "applicant@example.test", token: "opaque-token", expiresAt: "2026-08-17T00:00:00.000Z" });
  assert.equal(call?.url, "https://notify.example.test/hook");
  const payload = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["applicationId", "email", "expiresAt", "resumeUrl"]);
  assert.equal(payload.applicationId, "application:1");
  assert.equal(payload.resumeUrl, "https://apply.example.test/apply#resume=opaque-token");
  assert.equal(String(call?.init?.headers && (call?.init?.headers as Record<string, string>).Authorization), "Bearer synthetic-secret-1234");
  assert.equal(String(call?.init?.headers && (call?.init?.headers as Record<string, string>)["Idempotency-Key"]), "rent-ops-application:application:1");
  assert.equal(String(call?.init?.body).includes("synthetic-secret-1234"), false);
});

test("magic-link delivery has a bounded timeout and typed provider failures", async () => {
  const notifier = createMagicLinkWebhookNotifier({
    webhookUrl: "https://notify.example.test/hook",
    webhookSecret: "synthetic-secret-1234",
    publicAppUrl: "https://apply.example.test",
    timeoutMs: 100,
    fetchImpl: async () => new Promise<Response>(() => undefined),
  });
  await assert.rejects(
    () => notifier({ applicationId: "application:timeout", email: "applicant@example.test", token: "opaque-token", expiresAt: "2026-08-17T00:00:00.000Z" }),
    (error: unknown) => error instanceof MagicLinkDeliveryError && /timed out/i.test(error.message) && error.code === "MAGIC_LINK_DELIVERY_FAILED",
  );
});

test("notifier env factory fails closed on partial or non-HTTPS configuration", () => {
  assert.equal(createMagicLinkWebhookNotifierFromEnv({}), undefined);
  assert.throws(() => createMagicLinkWebhookNotifierFromEnv({ RENT_OPS_MAGIC_LINK_WEBHOOK_URL: "https://notify.example.test", RENT_OPS_PUBLIC_APP_URL: "https://apply.example.test" }), /requires URL, secret/i);
  assert.throws(() => createMagicLinkWebhookNotifierFromEnv({ RENT_OPS_MAGIC_LINK_WEBHOOK_URL: "http://notify.example.test", RENT_OPS_MAGIC_LINK_WEBHOOK_SECRET: "synthetic-secret-1234", RENT_OPS_PUBLIC_APP_URL: "https://apply.example.test" }), /HTTPS/i);
});
