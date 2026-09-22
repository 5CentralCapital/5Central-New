import {
  isoDateSchema,
  type IsoDate,
} from "../../../shared/company";
import type {
  QuickBooksAccountingClientConfig,
  QuickBooksJsonObject,
  QuickBooksTransportResponse,
} from "../../../shared/accounting/quickbooks";
import { QuickBooksIntegrationError } from "./errors";
import { DEFAULT_QUICKBOOKS_MINOR_VERSION, QUICKBOOKS_PRODUCTION_ACCOUNTING_BASE_URL, QUICKBOOKS_SANDBOX_ACCOUNTING_BASE_URL, quickBooksProviderFaultError } from "./accounting";
import { parseJsonLosslessNumbers } from "./json-lossless";

export type QuickBooksReportAccountingMethod = "Cash" | "Accrual";

/** Parameters supported by the QBO Reports REST query surface. */
export interface QuickBooksReportRequest {
  readonly startDate?: IsoDate | string;
  readonly endDate?: IsoDate | string;
  readonly dateMacro?: string;
  readonly accountingMethod?: QuickBooksReportAccountingMethod;
  readonly columns?: readonly string[];
  readonly groupBy?: string;
  readonly summarizeColumnBy?: string;
  readonly account?: string;
  readonly customer?: string;
  readonly class?: string;
  readonly department?: string;
  readonly vendor?: string;
  readonly reportDate?: IsoDate | string;
  /** Local readback assertion; this is not sent as an unsupported provider parameter. */
  readonly expectedCurrency?: string;
}

export interface QuickBooksReportResponse {
  readonly reportName: string;
  readonly scope: QuickBooksAccountingClientConfig["scope"];
  readonly accountingMethod: QuickBooksReportAccountingMethod | "unknown";
  readonly currency?: string;
  readonly raw: QuickBooksJsonObject;
  readonly status: number;
  readonly intuitTid?: string;
  /** Provider-declared empty result. An empty Rows array without this marker is not a verified zero. */
  readonly noReportData?: boolean;
  /** Provider response says the report exceeded the supported cell limit. */
  readonly truncated?: boolean;
}

export interface QuickBooksReportsClient {
  getReport(reportName: string, request?: QuickBooksReportRequest): Promise<QuickBooksReportResponse>;
}

function header(response: QuickBooksTransportResponse, name: string): string | undefined {
  return response.headers
    ? Object.entries(response.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]?.trim() || undefined
    : undefined;
}

function parseObject(body: string): QuickBooksJsonObject | undefined {
  try {
    const parsed: unknown = parseJsonLosslessNumbers(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as QuickBooksJsonObject : undefined;
  } catch {
    return undefined;
  }
}

function safeToken(value: unknown, field: string, max = 255): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new QuickBooksIntegrationError("quickbooks_validation", `QuickBooks report ${field} is invalid`);
  return value;
}

function baseUrl(environment: QuickBooksAccountingClientConfig["scope"]["environment"]): string {
  return environment === "sandbox" ? QUICKBOOKS_SANDBOX_ACCOUNTING_BASE_URL : QUICKBOOKS_PRODUCTION_ACCOUNTING_BASE_URL;
}

function assertReportName(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value)) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks report name is invalid");
}

function validateRequest(request: QuickBooksReportRequest): void {
  if (request.startDate !== undefined) isoDateSchema.parse(request.startDate);
  if (request.endDate !== undefined) isoDateSchema.parse(request.endDate);
  if (request.startDate === undefined && request.endDate === undefined) {
    // As-of reports use the provider's end_date parameter without inventing a
    // start date. Range reports still supply both values.
  }
  if (request.startDate !== undefined && request.endDate === undefined) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks report endDate is required when startDate is supplied");
  if (request.startDate !== undefined && request.endDate !== undefined && String(request.endDate) < String(request.startDate)) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks report endDate must follow startDate");
  if (request.reportDate !== undefined) isoDateSchema.parse(request.reportDate);
  if (request.dateMacro !== undefined) safeToken(request.dateMacro, "dateMacro", 80);
  if (request.accountingMethod !== undefined && request.accountingMethod !== "Cash" && request.accountingMethod !== "Accrual") throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks report accountingMethod is invalid");
  if (request.expectedCurrency !== undefined && !/^[A-Z]{3}$/.test(request.expectedCurrency)) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks report expectedCurrency is invalid");
  if (request.columns !== undefined && (!Array.isArray(request.columns) || request.columns.length > 100 || request.columns.some((value) => !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)))) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks report columns are invalid");
  for (const [field, value] of Object.entries(request)) if (field !== "columns" && field !== "expectedCurrency" && value !== undefined) safeToken(value, field, 255);
}

function reportHeader(raw: QuickBooksJsonObject): QuickBooksJsonObject {
  const value = raw.Header;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new QuickBooksIntegrationError("quickbooks_api", "QuickBooks report response has no verifiable header");
  return value as QuickBooksJsonObject;
}

function optionValue(value: unknown, name: string, depth = 0): unknown {
  if (depth > 3 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const object = item as Record<string, unknown>;
      const itemName = object.Name ?? object.name ?? object.Key ?? object.key;
      if (itemName === name) return object.Value ?? object.value ?? object.SelectedValue ?? object.selectedValue;
      const nested = optionValue(object.Option ?? object.Options ?? object.option ?? object.options, name, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  const direct = object[name] ?? object[name.toLowerCase()];
  if (direct !== undefined) return direct;
  for (const [key, child] of Object.entries(object)) {
    if (key.toLowerCase() === name.toLowerCase()) return child;
    const nested = optionValue(child, name, depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** QBO has returned report context as direct Header fields and, in some
 * response versions, as Name/Value entries below Header.Options. Keep the
 * verification strict while accepting both provider-shaped forms. */
function headerValue(header: QuickBooksJsonObject, name: string): unknown {
  if (header[name] !== undefined) return header[name];
  return optionValue(header.Options ?? header.Option, name);
}

function assertHeaderContext(raw: QuickBooksJsonObject, request: QuickBooksReportRequest): { method: QuickBooksReportAccountingMethod | "unknown"; currency: string | null } {
  const header = reportHeader(raw);
  const rawMethod = headerValue(header, "ReportBasis") ?? headerValue(header, "AccountingMethod");
  const method = rawMethod === "Cash" || rawMethod === "Accrual" ? rawMethod : "unknown";
  if (request.accountingMethod !== undefined && method !== request.accountingMethod) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks report basis did not match the requested accounting method");
  if (request.startDate !== undefined && headerValue(header, "StartPeriod") !== String(request.startDate)) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks report start period did not match the requested period");
  if (request.endDate !== undefined && headerValue(header, "EndPeriod") !== String(request.endDate)) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks report end period did not match the requested period");
  if (request.dateMacro !== undefined && headerValue(header, "DateMacro") !== request.dateMacro) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks report date macro was not verifiable");
  if (request.reportDate !== undefined && headerValue(header, "ReportDate") !== String(request.reportDate)) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks report date was not verifiable");
  if (request.summarizeColumnBy !== undefined && headerValue(header, "SummarizeColumnsBy") !== request.summarizeColumnBy) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks report grouping was not verifiable");
  const rawCurrency = headerValue(header, "Currency");
  const currency = rawCurrency === undefined ? null : safeToken(rawCurrency, "report currency", 3)?.toUpperCase() ?? null;
  if (request.expectedCurrency !== undefined && currency !== request.expectedCurrency) throw new QuickBooksIntegrationError("quickbooks_conflict", "QuickBooks report currency did not match the requested currency");
  const filterPairs: readonly [keyof QuickBooksReportRequest, string][] = [
    ["account", "Account"], ["customer", "Customer"], ["class", "Class"], ["department", "Department"], ["vendor", "Vendor"],
  ];
  for (const [requestKey, headerKey] of filterPairs) {
    const expected = request[requestKey];
    if (expected !== undefined && headerValue(header, headerKey) !== expected) throw new QuickBooksIntegrationError("quickbooks_conflict", `QuickBooks report ${String(requestKey)} filter was not verifiable`);
  }
  return { method, currency };
}

function providerFlag(value: unknown): boolean { return value === true || value === "true" || value === 1 || value === "1"; }

function containsProviderTruncation(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return /unable to display more data|400,?000 cells|400k cells/i.test(value);
  if (Array.isArray(value)) return value.some(item => containsProviderTruncation(item, depth + 1));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(item => containsProviderTruncation(item, depth + 1));
  return false;
}

function apiError(response: QuickBooksTransportResponse): QuickBooksIntegrationError {
  const transient = response.status === 408 || response.status === 429 || response.status >= 500;
  return new QuickBooksIntegrationError(response.status === 401 ? "quickbooks_unauthorized" : response.status === 429 ? "quickbooks_rate_limited" : "quickbooks_api", "QuickBooks report request failed", {
    status: response.status,
    retryable: transient,
    intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid"),
  });
}

export function createQuickBooksReportsClient(config: QuickBooksAccountingClientConfig): QuickBooksReportsClient {
  const scope = config.scope;
  const minorVersion = config.minorVersion ?? DEFAULT_QUICKBOOKS_MINOR_VERSION;
  if (typeof config.getAccessToken !== "function" || typeof config.transport !== "function") throw new QuickBooksIntegrationError("quickbooks_configuration", "QuickBooks Reports client requires token and transport providers");
  return {
    async getReport(reportName, request = {}) {
      assertReportName(reportName);
      validateRequest(request);
      const url = new URL(`/v3/company/${encodeURIComponent(scope.realmId)}/reports/${encodeURIComponent(reportName)}`, baseUrl(scope.environment));
      const params: Record<string, string> = {};
      if (request.startDate !== undefined) params.start_date = String(request.startDate);
      if (request.endDate !== undefined) params.end_date = String(request.endDate);
      if (request.dateMacro !== undefined) params.date_macro = request.dateMacro;
      if (request.accountingMethod !== undefined) params.accounting_method = request.accountingMethod;
      if (request.columns !== undefined) params.columns = request.columns.join(",");
      if (request.groupBy !== undefined) params.group_by = request.groupBy;
      if (request.summarizeColumnBy !== undefined) params.summarize_column_by = request.summarizeColumnBy;
      if (request.account !== undefined) params.account = request.account;
      if (request.customer !== undefined) params.customer = request.customer;
      if (request.class !== undefined) params.class = request.class;
      if (request.department !== undefined) params.department = request.department;
      if (request.vendor !== undefined) params.vendor = request.vendor;
      if (request.reportDate !== undefined) params.report_date = String(request.reportDate);
      if (!/^\d{1,4}$/.test(minorVersion)) throw new QuickBooksIntegrationError("quickbooks_validation", "QuickBooks minor version is invalid");
      params.minorversion = minorVersion;
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const token = await config.getAccessToken();
      if (!token) throw new QuickBooksIntegrationError("quickbooks_unauthorized", "QuickBooks access token is unavailable");
      const response = await config.transport({ method: "GET", url: url.toString(), headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
      if (response.status < 200 || response.status >= 300) throw apiError(response);
      const fault = quickBooksProviderFaultError(response);
      if (fault) throw fault;
      const raw = parseObject(response.body);
      if (!raw) throw new QuickBooksIntegrationError("quickbooks_api", "QuickBooks report response could not be confirmed", { status: response.status });
      const context = assertHeaderContext(raw, request);
      const rawHeader = reportHeader(raw);
      return {
        reportName,
        scope,
        accountingMethod: context.method,
        ...(context.currency ? { currency: context.currency } : {}),
        raw,
        status: response.status,
        noReportData: providerFlag(headerValue(rawHeader, "NoReportData")),
        truncated: containsProviderTruncation(raw),
        ...(header(response, "intuit_tid") ?? header(response, "intuit-tid") ? { intuitTid: header(response, "intuit_tid") ?? header(response, "intuit-tid") } : {}),
      };
    },
  };
}
