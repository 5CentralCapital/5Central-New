import type { QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { AccountingError } from "./errors";

/*
 * Source-event tag for QuickBooks creates.
 *
 * Intuit does not document how long it remembers a `requestid`, so a create
 * whose response was lost must be found by reading QuickBooks. Invoices,
 * payments, credit memos, journal entries and bills have no natural key to
 * query by, so every create carries a stable line `5CO:<operation key>` in its
 * internal note. A later reconciler can match that line exactly instead of
 * holding the write for manual review forever.
 *
 * Customer has no PrivateNote in the QuickBooks API; its internal free-form
 * field is `Notes` (at most 2,000 characters). The other entities use
 * `PrivateNote` (at most 4,000 characters). Existing note text is kept and
 * shortened only as much as the tag needs.
 */

export const QBO_SOURCE_TAG_PREFIX = "5CO:";

/** Entity -> internal note field and its Intuit length limit. */
export const QBO_SOURCE_TAG_FIELDS: Readonly<Record<string, { readonly field: string; readonly maxLength: number }>> = Object.freeze({
  Invoice: { field: "PrivateNote", maxLength: 4000 },
  Payment: { field: "PrivateNote", maxLength: 4000 },
  CreditMemo: { field: "PrivateNote", maxLength: 4000 },
  JournalEntry: { field: "PrivateNote", maxLength: 4000 },
  Bill: { field: "PrivateNote", maxLength: 4000 },
  Customer: { field: "Notes", maxLength: 2000 },
});

export function qboSourceTag(operationKey: string): string {
  return `${QBO_SOURCE_TAG_PREFIX}${operationKey}`;
}

function hasTagLine(note: string, tag: string): boolean {
  return note.split(/\r?\n/).some(line => line.trim() === tag);
}

/** Cut to at most `length` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, "");
}

/**
 * The create fields with the source tag on its own last line of the note.
 * Other entities and non-create operations are returned unchanged. Pure and
 * deterministic, so the request hash stays stable across retries.
 */
export function withQboSourceTag(entity: string, operation: string, fields: QuickBooksJsonObject, operationKey: string): QuickBooksJsonObject {
  const target = QBO_SOURCE_TAG_FIELDS[entity];
  if (!target || operation !== "create") return fields;
  const tag = qboSourceTag(operationKey);
  const existing = fields[target.field];
  if (existing !== undefined && existing !== null && typeof existing !== "string") {
    throw new AccountingError("accounting_validation", `QuickBooks ${entity} ${target.field} must be text`);
  }
  // Drop an earlier copy of the tag so re-tagging is idempotent.
  const note = (existing ?? "").split(/\r?\n/).filter(line => line.trim() !== tag).join("\n").replace(/\s+$/, "");
  const kept = cut(note, target.maxLength - tag.length - 1).replace(/\s+$/, "");
  return { ...fields, [target.field]: kept ? `${kept}\n${tag}` : tag };
}

/** Whether a record read from QuickBooks carries this operation's source tag. */
export function hasQboSourceTag(entity: string, record: QuickBooksJsonObject | null | undefined, operationKey: string): boolean {
  const target = QBO_SOURCE_TAG_FIELDS[entity];
  const note = target && record ? record[target.field] : undefined;
  return typeof note === "string" && hasTagLine(note, qboSourceTag(operationKey));
}
