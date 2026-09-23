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

/** A validated Intuit CloudEvents notification. `intuitAccountId` is the realm ID. */
export interface QuickBooksCloudEvent extends QuickBooksWebhookEvent {
  readonly specVersion: string;
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly intuitAccountId: string;
  readonly time: string;
}

const MAX_WEBHOOK_EVENTS = 1_000;
const EVENT_ID = /^[A-Za-z0-9_.:@\/-]{1,255}$/;
const EVENT_TYPE = /^qbo\.[a-z0-9]+(?:\.[a-z0-9]+)*\.v\d{1,3}$/;
const REALM_ID = /^\d{1,32}$/;
const ENTITY_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

function requiredText(event: Record<string, unknown>, field: string, pattern: RegExp): string {
  const value = event[field];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`QuickBooks webhook event ${field} is invalid`);
  return value;
}

/**
 * Parse only after signature verification; this never accepts a parsed body
 * as proof. Intuit delivers only the CloudEvents format: a JSON array of
 * events carrying specversion, id, source, type, time and intuitaccountid
 * (the realm ID), with optional intuitentityid and data. The retired legacy
 * `eventNotifications` envelope and malformed events are rejected. Duplicate
 * event IDs within one delivery are collapsed; cross-delivery replay is
 * handled by `filterNewQuickBooksWebhookEvents`.
 */
export function parseQuickBooksWebhookPayload(rawBody: string | Uint8Array): readonly QuickBooksCloudEvent[] {
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("QuickBooks webhook payload is invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("QuickBooks webhook payload must be a CloudEvents array");
  if (parsed.length > MAX_WEBHOOK_EVENTS) throw new Error("QuickBooks webhook payload has too many events");
  const seen = new Set<string>();
  const events: QuickBooksCloudEvent[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QuickBooks webhook event is invalid");
    const event = value as Record<string, unknown>;
    const specVersion = requiredText(event, "specversion", /^1\.0$/);
    const id = requiredText(event, "id", EVENT_ID);
    const source = requiredText(event, "source", /^[^\u0000-\u001f\u007f]{1,512}$/);
    const type = requiredText(event, "type", EVENT_TYPE);
    const intuitAccountId = requiredText(event, "intuitaccountid", REALM_ID);
    const time = requiredText(event, "time", /^[0-9T:.+\-Z]{10,40}$/);
    if (!Number.isFinite(Date.parse(time))) throw new Error("QuickBooks webhook event time is invalid");
    const intuitEntityId = event.intuitentityid === undefined ? undefined : requiredText(event, "intuitentityid", ENTITY_ID);
    const dedupeKey = `${intuitAccountId}\u0000${id}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    events.push({
      specVersion,
      id,
      source,
      type,
      intuitAccountId,
      time,
      ...(intuitEntityId === undefined ? {} : { intuitEntityId }),
      ...("data" in event ? { data: event.data } : {}),
    });
  }
  return events;
}

/** Durable at-least-once de-duplication, e.g. an INSERT ... ON CONFLICT DO NOTHING keyed by realm and event ID. */
export interface QuickBooksWebhookEventLedger {
  /** Returns true only for the first recording of this realm/event ID. */
  recordIfNew(realmId: string, eventId: string): Promise<boolean>;
}

/**
 * Intuit delivers at least once and out of order. Keep only events that the
 * ledger has not already accepted; ordering must come from provider
 * read-back (LastUpdatedTime/SyncToken), never from delivery order.
 */
export async function filterNewQuickBooksWebhookEvents(
  events: readonly QuickBooksCloudEvent[],
  ledger: QuickBooksWebhookEventLedger,
): Promise<readonly QuickBooksCloudEvent[]> {
  const fresh: QuickBooksCloudEvent[] = [];
  for (const event of events) {
    if (await ledger.recordIfNew(event.intuitAccountId, event.id)) fresh.push(event);
  }
  return fresh;
}
