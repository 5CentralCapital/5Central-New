import { decimalPower10, legacyNumberToDecimal, parseDecimalParts } from "../../shared/company/decimal";
import { currencyCodeSchema } from "../../shared/company/money";
import { centsFromBigInt } from "../../shared/company/money";
import { createHash } from "node:crypto";
import {
  MRA_PACKET_FORMAT,
  MRA_SOURCE_TRANSACTION_KINDS,
  mraPacketCandidateSchema,
  mraSourceLineCandidateSchema,
  type IntakeEvidence,
  type MraAccountCandidate,
  type MraPacketCandidate,
  type MraSourceLineCandidate,
} from "../../shared/intake";
import { read, utils, type WorkBook } from "xlsx";

export interface MraSourceBytes {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly declaredContentType: string;
}

export interface MraSourceAdapter {
  readonly kind: "structured" | "xlsx" | "pdf";
  canHandle(input: Pick<MraSourceBytes, "fileName" | "declaredContentType">): boolean;
  parse(input: MraSourceBytes): Promise<MraPacketCandidate>;
}

const text = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result.length > 0 ? result : undefined;
};

function sourceText(value: unknown, fallback: string | undefined = undefined): string | undefined {
  const result = text(value) ?? fallback;
  if (result === undefined) return undefined;
  if (result.length > 500 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error("intake_source_text_invalid");
  return result;
}

function dateText(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
  if (slash) {
    const month = slash[1]!.padStart(2, "0");
    const day = slash[2]!.padStart(2, "0");
    return `${slash[3]}-${month}-${day}`;
  }
  throw new Error("intake_source_date_invalid");
}

function moneyText(value: unknown, inputUnit: "dollars" | "cents" = "dollars"): string {
  if (inputUnit === "cents") {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) throw new Error("intake_amount_cents_unsafe_number");
      return centsFromBigInt(BigInt(value));
    }
    let rawCents = text(value);
    if (!rawCents) throw new Error("intake_amount_missing");
    let negativeCents = false;
    if (rawCents.startsWith("(") && rawCents.endsWith(")")) {
      negativeCents = true;
      rawCents = rawCents.slice(1, -1).trim();
    }
    rawCents = rawCents.replaceAll(",", "").trim();
    if (rawCents.startsWith("-")) {
      negativeCents = !negativeCents;
      rawCents = rawCents.slice(1);
    } else if (rawCents.startsWith("+")) {
      rawCents = rawCents.slice(1);
    }
    if (!/^\d+$/.test(rawCents)) throw new Error("intake_amount_cents_not_integer");
    const cents = BigInt(rawCents);
    return centsFromBigInt(negativeCents ? -cents : cents);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) throw new Error("intake_amount_unsafe_number");
    return dollarsText(legacyNumberToDecimal(value));
  }
  let raw = text(value);
  if (!raw) throw new Error("intake_amount_missing");
  let negative = false;
  if (raw.startsWith("(") && raw.endsWith(")")) {
    negative = true;
    raw = raw.slice(1, -1).trim();
  }
  raw = raw.replaceAll(",", "").replace(/^\$/, "").trim();
  if (raw.startsWith("-")) {
    negative = !negative;
    raw = raw.slice(1);
  }
  return dollarsText(`${negative ? "-" : ""}${raw}`);
}

function dollarsText(raw: string): string {
  const parts = parseDecimalParts(raw);
  if (parts.scale > 2) throw new Error("intake_amount_has_more_than_two_decimal_places");
  const cents = parts.coefficient * decimalPower10(2 - parts.scale);
  return centsFromBigInt(parts.sign < 0 ? -cents : cents);
}

function valueAtWithKey(record: Record<string, unknown>, ...keys: string[]): { key: string; value: unknown } | undefined {
  const normalized = new Map(Object.entries(record).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
  for (const key of keys) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const value = normalized.get(normalizedKey);
    if (value !== undefined && value !== null && String(value).trim() !== "") return { key: normalizedKey, value };
  }
  return undefined;
}

function valueAt(record: Record<string, unknown>, ...keys: string[]): unknown {
  return valueAtWithKey(record, ...keys)?.value;
}

function identityFingerprint(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function evidence(value: unknown, fallback: IntakeEvidence): IntakeEvidence[] {
  if (!Array.isArray(value)) return [fallback];
  const result = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).map((item) => ({
    ...(item.page !== undefined ? { page: Number(item.page) } : {}),
    ...(item.row !== undefined ? { row: Number(item.row) } : {}),
    ...(item.section !== undefined ? { section: sourceText(item.section) } : {}),
    ...(item.sourcePath !== undefined ? { sourcePath: sourceText(item.sourcePath) } : {}),
    ...(item.excerptSha256 !== undefined ? { excerptSha256: sourceText(item.excerptSha256) } : {}),
  }));
  return result.length > 0 ? result : [fallback];
}

function canonicalizeLines(accountsInput: readonly Record<string, unknown>[], packetPeriod?: { from?: string; through?: string }, adapter: "structured" | "xlsx" | "pdf" = "structured"): MraPacketCandidate {
  const accounts: MraAccountCandidate[] = [];
  const dates: string[] = [];
  let lineNumber = 0;
  const seen = new Set<string>();
  const seenProviderIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  for (const accountInput of accountsInput) {
    const sourceAccountId = sourceText(valueAt(accountInput, "sourceAccountId", "accountId", "account", "accountNumber"));
    if (!sourceAccountId) throw new Error("intake_source_account_id_missing");
    const sourceAccountName = sourceText(valueAt(accountInput, "sourceAccountName", "accountName", "accountLabel"));
    const accountCurrency = currencyCodeSchema.parse(sourceText(valueAt(accountInput, "currency", "currencyCode")) ?? "USD");
    const rawLines = valueAt(accountInput, "lines", "rows", "transactions");
    if (!Array.isArray(rawLines)) throw new Error("intake_source_account_lines_missing");
    const lines: MraSourceLineCandidate[] = [];
    for (const rawLine of rawLines) {
      if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) throw new Error("intake_source_line_invalid");
      const line = rawLine as Record<string, unknown>;
      lineNumber += 1;
      const postedOn = dateText(valueAt(line, "postedOn", "postedDate", "date", "transactionDate"));
      if (!postedOn) throw new Error("intake_source_line_date_missing");
      const periodMonth = dateText(valueAt(line, "periodMonth", "month", "rentMonth")) ?? postedOn.slice(0, 7) + "-01";
      const tenantSourceId = sourceText(valueAt(line, "tenantSourceId", "tenantId", "residentId", "accountId"));
      const amountField = valueAtWithKey(line, "amountCents", "amount", "total", "balance");
      if (!amountField) throw new Error("intake_amount_missing");
      const amountUnit = amountField.key === "amountcents" ? "cents" : "dollars";
      const amountCents = moneyText(amountField.value, amountUnit);
      const providerTransactionId = sourceText(valueAt(line, "providerTransactionId", "transactionId", "transactionReference", "externalId"));
      const originalSourceIdentity = sourceText(valueAt(line, "originalSourceIdentity", "sourceIdentity", "providerTransactionId", "transactionId", "transactionReference", "externalId"));
      const category = sourceText(valueAt(line, "category", "lineCategory", "chargeType"))?.toLowerCase() ?? "unknown";
      const payer = sourceText(valueAt(line, "payer", "payerType", "source"))?.toLowerCase() ?? "unknown";
      const rawTransactionKind = sourceText(valueAt(line, "transactionKind", "kind", "semantic", "lineKind"))?.toLowerCase().replace(/[^a-z0-9_]/g, "_") ?? "unknown";
      const transactionKind = (MRA_SOURCE_TRANSACTION_KINDS as readonly string[]).includes(rawTransactionKind) ? rawTransactionKind : "unknown";
      const rawDirection = sourceText(valueAt(line, "direction", "flow", "cashDirection"))?.toLowerCase() ?? "unknown";
      const direction = rawDirection === "inflow" || rawDirection === "incoming" ? "inflow" : rawDirection === "outflow" || rawDirection === "outgoing" ? "outflow" : "unknown";
      const currency = currencyCodeSchema.parse(sourceText(valueAt(line, "currency", "currencyCode")) ?? accountCurrency);
      const description = sourceText(valueAt(line, "description", "memo", "note")) ?? null;
      const identityContent = {
        sourceAccountId,
        postedOn,
        periodMonth,
        amountCents,
        currency,
        category,
        payer,
        tenantSourceId: tenantSourceId ?? null,
        propertySourceId: sourceText(valueAt(line, "propertySourceId", "propertyId", "property")) ?? null,
        unitSourceId: sourceText(valueAt(line, "unitSourceId", "unitId", "unit")) ?? null,
        description,
      };
      const fingerprint = identityFingerprint(identityContent);
      if (providerTransactionId) {
        const providerKey = `${sourceAccountId}:${providerTransactionId}`;
        if (seenProviderIds.has(providerKey)) throw new Error("intake_source_provider_transaction_duplicate");
        seenProviderIds.add(providerKey);
      } else {
        // A content-only identity is safe only when it is unique in the packet.
        // Identical rows without a provider ID are held at the source boundary
        // instead of being silently deduplicated.
        if (seenFingerprints.has(fingerprint)) throw new Error("intake_source_line_identity_ambiguous");
        seenFingerprints.add(fingerprint);
      }
      const explicitSourceLineKey = sourceText(valueAt(line, "sourceLineKey", "lineKey"));
      const sourceLineKey = explicitSourceLineKey ?? (providerTransactionId
        ? `mra:${identityFingerprint({ sourceAccountId, providerTransactionId })}`
        : `mra:${sourceAccountId}:${fingerprint}`);
      if (seen.has(sourceLineKey)) throw new Error("intake_source_line_key_duplicate");
      seen.add(sourceLineKey);
      dates.push(postedOn);
      lines.push(mraPacketCandidateLine({
        sourceLineKey,
        providerTransactionId,
        originalSourceIdentity: originalSourceIdentity ?? providerTransactionId ?? sourceLineKey,
        sourceAccountId,
        sourceAccountName,
        sourceRevision: sourceText(valueAt(line, "sourceRevision", "revision", "version")) ?? "packet",
        tenantSourceId,
        tenantDisplayName: sourceText(valueAt(line, "tenantDisplayName", "tenantName", "residentName")),
        propertySourceId: sourceText(valueAt(line, "propertySourceId", "propertyId", "property")),
        unitSourceId: sourceText(valueAt(line, "unitSourceId", "unitId", "unit")),
        postedOn,
        dueOn: dateText(valueAt(line, "dueOn", "dueDate")) ?? null,
        periodMonth,
        amountCents,
        currency,
        category,
        payer,
        transactionKind,
        direction,
        provenance: { sourceSystem: "mra", adapter },
        description,
        correctsSourceLineKey: sourceText(valueAt(line, "correctsSourceLineKey", "corrects", "supersedes")),
        evidence: evidence(valueAt(line, "evidence", "sourceEvidence"), { row: lineNumber }),
      }));
    }
    accounts.push({ sourceAccountId, sourceAccountName: sourceAccountName ?? null, currency: accountCurrency, lines, evidence: [] });
  }
  if (accounts.length === 0 || accounts.every((account) => account.lines.length === 0)) throw new Error("intake_source_has_no_lines");
  const from = packetPeriod?.from ?? dates.slice().sort()[0];
  const through = packetPeriod?.through ?? dates.slice().sort().at(-1);
  if (!from || !through) throw new Error("intake_source_period_missing");
  return mraPacketCandidateSchema.parse({ format: MRA_PACKET_FORMAT, packetRevision: "1", period: { from, through }, accounts, extractionWarnings: [] });
}

function mraPacketCandidateLine(value: Record<string, unknown>): MraSourceLineCandidate {
  return mraSourceLineCandidateSchema.parse(value);
}

export function parseStructuredMraPacket(value: unknown): MraPacketCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("intake_structured_packet_invalid");
  const root = value as Record<string, unknown>;
  const candidate = root.candidate && typeof root.candidate === "object" && !Array.isArray(root.candidate) ? root.candidate as Record<string, unknown> : root;
  const accounts = candidate.accounts;
  if (!Array.isArray(accounts)) throw new Error("intake_structured_accounts_missing");
  const period = candidate.period && typeof candidate.period === "object" && !Array.isArray(candidate.period) ? candidate.period as { from?: string; through?: string } : undefined;
  return canonicalizeLines(accounts.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)), period);
}

class StructuredMraSourceAdapter implements MraSourceAdapter {
  readonly kind = "structured" as const;
  canHandle(input: Pick<MraSourceBytes, "fileName" | "declaredContentType">): boolean {
    return input.declaredContentType.toLowerCase() === "application/json" || /\.json$/i.test(input.fileName);
  }
  async parse(input: MraSourceBytes): Promise<MraPacketCandidate> {
    let value: unknown;
    try { value = JSON.parse(Buffer.from(input.bytes).toString("utf8")); } catch { throw new Error("intake_structured_json_invalid"); }
    return parseStructuredMraPacket(value);
  }
}

function worksheetRows(bytes: Uint8Array): string[][] {
  let workbook: WorkBook;
  try { workbook = read(Buffer.from(bytes), { type: "buffer", cellDates: false, raw: false }); } catch { throw new Error("intake_xlsx_invalid"); }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("intake_xlsx_sheet_missing");
  const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName]!, { header: 1, raw: false, defval: "" });
  return rows.map((row) => row.map((value) => String(value ?? "").trim()));
}

class XlsxMraSourceAdapter implements MraSourceAdapter {
  readonly kind = "xlsx" as const;
  canHandle(input: Pick<MraSourceBytes, "fileName" | "declaredContentType">): boolean {
    return /\.xlsx?$/i.test(input.fileName) || input.declaredContentType.includes("spreadsheet") || input.declaredContentType.includes("excel");
  }
  async parse(input: MraSourceBytes): Promise<MraPacketCandidate> {
    const rows = worksheetRows(input.bytes);
    const headerIndex = rows.findIndex((row) => row.some((cell) => /account|tenant|resident|amount|posted|transaction/i.test(cell)));
    if (headerIndex < 0) throw new Error("intake_xlsx_header_missing");
    const header = rows[headerIndex]!.map((cell) => cell.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const index = (...names: string[]) => names.map((name) => header.indexOf(name)).find((value) => value >= 0) ?? -1;
    const accountIndex = index("sourceaccountid", "accountid", "account", "accountnumber");
    const dateIndex = index("postedon", "posteddate", "date", "transactiondate");
    const amountIndex = index("amountcents", "amount", "total", "balance");
    if (accountIndex < 0 || dateIndex < 0 || amountIndex < 0) throw new Error("intake_xlsx_required_columns_missing");
    const byAccount = new Map<string, Record<string, unknown>[]>();
    for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      if (row.every((cell) => cell === "")) continue;
      const accountId = row[accountIndex];
      if (!accountId) throw new Error("intake_xlsx_account_missing");
      const record: Record<string, unknown> = {
        sourceAccountId: accountId,
        sourceAccountName: row[index("sourceaccountname", "accountname", "accountlabel")] ?? undefined,
        tenantSourceId: row[index("tenantsourceid", "tenantid", "residentid")] ?? undefined,
        tenantDisplayName: row[index("tenantdisplayname", "tenantname", "residentname")] ?? undefined,
        propertySourceId: row[index("propertysourceid", "propertyid", "property")] ?? undefined,
        unitSourceId: row[index("unitsourceid", "unitid", "unit")] ?? undefined,
        postedOn: row[dateIndex],
        dueOn: row[index("dueon", "duedate")] ?? undefined,
        periodMonth: row[index("periodmonth", "month", "rentmonth")] ?? undefined,
        ...(header[amountIndex] === "amountcents" ? { amountCents: row[amountIndex] } : { amount: row[amountIndex] }),
        providerTransactionId: row[index("providertransactionid", "transactionid", "transactionreference", "externalid")] ?? undefined,
        currency: row[index("currency", "currencycode")] || "USD",
        category: row[index("category", "linecategory", "chargetype")] || "unknown",
        payer: row[index("payer", "payertype", "source")] || "unknown",
        description: row[index("description", "memo", "note")] || undefined,
        evidence: [{ row: rowIndex + 1, sourcePath: `${input.fileName}#${rows[headerIndex]!.join(",")}` }],
      };
      const list = byAccount.get(String(accountId)) ?? [];
      list.push(record);
      byAccount.set(String(accountId), list);
    }
    return canonicalizeLines(Array.from(byAccount.entries()).map(([sourceAccountId, lines]) => ({ sourceAccountId, lines })), undefined, "xlsx");
  }
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdf.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  for (let pageNo = 1; pageNo <= document.numPages; pageNo += 1) {
    const page = await document.getPage(pageNo);
    const content = await page.getTextContent();
    pages.push((content.items as Array<{ str?: string }>).map((item) => item.str ?? "").join(" "));
  }
  return pages.join("\n");
}

class PdfMraSourceAdapter implements MraSourceAdapter {
  readonly kind = "pdf" as const;
  canHandle(input: Pick<MraSourceBytes, "fileName" | "declaredContentType">): boolean {
    return input.declaredContentType.toLowerCase() === "application/pdf" || /\.pdf$/i.test(input.fileName);
  }
  async parse(input: MraSourceBytes): Promise<MraPacketCandidate> {
    const textContent = await extractPdfText(input.bytes);
    const rows = textContent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const delimiter = rows.find((row) => row.includes("|"))?.includes("|") ? "|" : rows.find((row) => row.includes("\t")) ? "\t" : undefined;
    if (!delimiter) throw new Error("intake_pdf_itemized_rows_unavailable");
    const split = (row: string) => row.split(delimiter).map((value) => value.trim());
    const header = split(rows[0]!).map((cell) => cell.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const index = (...names: string[]) => names.map((name) => header.indexOf(name)).find((value) => value >= 0) ?? -1;
    const accountIndex = index("sourceaccountid", "accountid", "account", "accountnumber");
    const dateIndex = index("postedon", "posteddate", "date", "transactiondate");
    const amountIndex = index("amountcents", "amount", "total", "balance");
    if (accountIndex < 0 || dateIndex < 0 || amountIndex < 0) throw new Error("intake_pdf_required_columns_missing");
    const byAccount = new Map<string, Record<string, unknown>[]>();
    for (let indexRow = 1; indexRow < rows.length; indexRow += 1) {
      const cells = split(rows[indexRow]!);
      if (cells.length < header.length) throw new Error("intake_pdf_row_unaccounted");
      const accountId = cells[accountIndex];
      if (!accountId) throw new Error("intake_pdf_account_missing");
      const record: Record<string, unknown> = {
        sourceAccountId: accountId,
        sourceAccountName: cells[index("sourceaccountname", "accountname", "accountlabel")],
        tenantSourceId: cells[index("tenantsourceid", "tenantid", "residentid")],
        tenantDisplayName: cells[index("tenantdisplayname", "tenantname", "residentname")],
        propertySourceId: cells[index("propertysourceid", "propertyid", "property")],
        unitSourceId: cells[index("unitsourceid", "unitid", "unit")],
        postedOn: cells[dateIndex],
        dueOn: cells[index("dueon", "duedate")],
        periodMonth: cells[index("periodmonth", "month", "rentmonth")],
        ...(header[amountIndex] === "amountcents" ? { amountCents: cells[amountIndex] } : { amount: cells[amountIndex] }),
        providerTransactionId: cells[index("providertransactionid", "transactionid", "transactionreference", "externalid")] || undefined,
        currency: cells[index("currency", "currencycode")] || "USD",
        category: cells[index("category", "linecategory", "chargetype")] || "unknown",
        payer: cells[index("payer", "payertype", "source")] || "unknown",
        description: cells[index("description", "memo", "note")],
        evidence: [{ row: indexRow + 1, section: "itemized_payment_lines" }],
      };
      const list = byAccount.get(accountId) ?? [];
      list.push(record);
      byAccount.set(accountId, list);
    }
    if (byAccount.size === 0) throw new Error("intake_pdf_itemized_rows_missing");
    return canonicalizeLines(Array.from(byAccount.entries()).map(([sourceAccountId, lines]) => ({ sourceAccountId, lines })), undefined, "pdf");
  }
}

export const mraSourceAdapters: readonly MraSourceAdapter[] = Object.freeze([
  new StructuredMraSourceAdapter(),
  new XlsxMraSourceAdapter(),
  new PdfMraSourceAdapter(),
]);

export async function parseMraSource(input: MraSourceBytes, adapters: readonly MraSourceAdapter[] = mraSourceAdapters): Promise<MraPacketCandidate> {
  const adapter = adapters.find((candidate) => candidate.canHandle(input));
  if (!adapter) throw new Error("intake_source_format_unconfigured");
  return adapter.parse(input);
}
