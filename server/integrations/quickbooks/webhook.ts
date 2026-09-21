import { createHmac, timingSafeEqual } from "node:crypto";
import type { QuickBooksWebhookEvent } from "../../../shared/accounting/quickbooks";

/**
 * Intuit signs the exact request bytes with HMAC-SHA256 and encodes the digest
 * as base64 in the `intuit-signature` header. Callers must capture the raw
 * request body before JSON parsing.
 */
export function quickBooksWebhookSignature(rawBody: string | Uint8Array, verifierToken: string): string {
  if (!verifierToken || /[\u0000-\u001f\u007f]/.test(verifierToken)) throw new Error("QuickBooks webhook verifier token is invalid");
  return createHmac("sha256", verifierToken).update(rawBody).digest("base64");
}

export function verifyQuickBooksWebhookSignature(
  rawBody: string | Uint8Array,
  signature: string | undefined,
  verifierToken: string,
): boolean {
  if (!signature || signature.length > 512) return false;
  let provided: Buffer;
  try {
    provided = Buffer.from(signature.trim(), "base64");
  } catch {
    return false;
  }
  const expected = Buffer.from(quickBooksWebhookSignature(rawBody, verifierToken), "base64");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Parse only after signature verification; this never accepts a parsed body as proof. */
export function parseQuickBooksWebhookPayload(rawBody: string | Uint8Array): readonly QuickBooksWebhookEvent[] {
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("QuickBooks webhook payload is invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("QuickBooks webhook payload must be an array");
  return parsed.map((value): QuickBooksWebhookEvent => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QuickBooks webhook event is invalid");
    const event = value as Record<string, unknown>;
    return {
      ...(typeof event.id === "string" ? { id: event.id } : {}),
      ...(typeof event.source === "string" ? { source: event.source } : {}),
      ...(typeof event.type === "string" ? { type: event.type } : {}),
      ...(typeof event.intuitaccountid === "string" ? { intuitAccountId: event.intuitaccountid } : {}),
      ...(typeof event.intuitentityid === "string" ? { intuitEntityId: event.intuitentityid } : {}),
      ...(typeof event.time === "string" ? { time: event.time } : {}),
      ...("data" in event ? { data: event.data } : {}),
    };
  });
}
