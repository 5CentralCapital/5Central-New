import { z } from "zod";
import type { QuickBooksAccountingClient } from "../../integrations/quickbooks/accounting";
import type { QuickBooksConnectionScope, QuickBooksJsonObject } from "../../../shared/accounting/quickbooks";
import { isQuickBooksHostedInvoiceUrl, type QboTenantPaymentInvoice, type QboTenantPaymentLink, type QboTenantPaymentView } from "../../../shared/tenant-qbo-payment-contracts";
import type { TenantIdentity } from "../../../shared/tenant-portal-contracts";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { presentTenantHome, tenantAccountLedgerRows } from "../tenant-portal/presentation";
import { resolveTenancyHistory, resolveTenancySource, currentBusinessDate } from "../../accounting/tenancy-source-resolution";
import { payableAccount, type TenantPayment } from "./model";

const ENV_ENABLED = "RENT_OPS_QBO_HOSTED_PAYMENTS_ENABLED";
const ENV_CONFIG = "RENT_OPS_QBO_HOSTED_PAYMENTS_CONFIG_JSON";
const MAX_CONFIG_CHARS = 100_000;
const MAX_INVOICES_PER_ENTITY = 100;
const MAX_QBO_CUSTOMER_INVOICES = 1_000;

const qboIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const localIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const emailSchema = z.string().trim().email().max(254).transform(value => value.toLowerCase());
const centsSchema = z.string().regex(/^(?:0|[1-9]\d{0,18})$/);
const isoDateTime = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));

const readinessSchema = z.object({
  enrolled: z.boolean().optional(),
  businessVerified: z.boolean().optional(),
  payoutBankVerified: z.boolean().optional(),
  receiptEmailsAllowed: z.boolean().optional(),
  receiptReconciliationVerified: z.boolean().optional(),
}).strict().default({}).transform(value => ({
  enrolled: value.enrolled === true,
  businessVerified: value.businessVerified === true,
  payoutBankVerified: value.payoutBankVerified === true,
  receiptEmailsAllowed: value.receiptEmailsAllowed === true,
  receiptReconciliationVerified: value.receiptReconciliationVerified === true,
}));

const approvalSchema = z.object({
  invoiceId: qboIdSchema,
  invoiceNumber: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  invoiceSyncToken: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
  balanceCents: centsSchema,
  customerId: qboIdSchema,
  tenancyId: localIdSchema,
  personId: localIdSchema,
  tenantAccountId: localIdSchema,
  tenantEmail: emailSchema,
  expiresAt: isoDateTime,
}).strict();

const entitySchema = z.object({
  organizationId: z.string().uuid(),
  legalEntityId: z.string().uuid(),
  environment: z.literal("production"),
  realmId: z.string().regex(/^\d{1,32}$/),
  readiness: readinessSchema,
  invoices: z.array(approvalSchema).max(MAX_INVOICES_PER_ENTITY).default([]),
}).strict();

export interface QboHostedReadinessFlags {
  readonly enrolled: boolean;
  readonly businessVerified: boolean;
  readonly payoutBankVerified: boolean;
  readonly receiptEmailsAllowed: boolean;
  readonly receiptReconciliationVerified: boolean;
}

export interface QboHostedInvoiceApproval {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceSyncToken: string;
  readonly balanceCents: string;
  readonly customerId: string;
  readonly tenancyId: string;
  readonly personId: string;
  readonly tenantAccountId: string;
  readonly tenantEmail: string;
  readonly expiresAt: string;
}

export interface QboHostedEntityConfig {
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly environment: "production";
  readonly realmId: string;
  readonly readiness: QboHostedReadinessFlags;
  readonly invoices: readonly QboHostedInvoiceApproval[];
}

export interface QboHostedPaymentsConfig {
  readonly enabled: boolean;
  readonly tenantCheckoutEnabled: boolean;
  readonly configurationValid: boolean;
  readonly entities: readonly QboHostedEntityConfig[];
}

export interface QboHostedEntityReadiness {
  readonly legalEntityId: string;
  readonly ready: boolean;
  readonly blockers: string[];
  readonly readiness: QboHostedReadinessFlags;
  readonly approvedInvoiceCount: number;
}

export interface QboHostedPaymentsReadiness {
  readonly provider: "quickbooks";
  readonly enabled: boolean;
  readonly blockers: string[];
  readonly entities: QboHostedEntityReadiness[];
}

/** Safe error boundary for tenant routes; messages never contain provider or tenant data. */
export class QboHostedPaymentError extends Error {
  constructor(readonly code: string, readonly status = 503) {
    super(code);
    this.name = "QboHostedPaymentError";
  }
}

const falseReadiness: QboHostedReadinessFlags = {
  enrolled: false,
  businessVerified: false,
  payoutBankVerified: false,
  receiptEmailsAllowed: false,
  receiptReconciliationVerified: false,
};

function validConfig(config: unknown): config is QboHostedPaymentsConfig {
  if (!config || typeof config !== "object") return false;
  const value = config as Partial<QboHostedPaymentsConfig>;
  if (typeof value.enabled !== "boolean" || typeof value.tenantCheckoutEnabled !== "boolean" || typeof value.configurationValid !== "boolean" || !Array.isArray(value.entities)) return false;
  if (value.entities.some(entity => !entity || typeof entity !== "object" || !Array.isArray((entity as QboHostedEntityConfig).invoices))) return false;
  return true;
}

function uniqueConfig(entities: readonly QboHostedEntityConfig[]): boolean {
  const scopes = new Set<string>();
  const approvals = new Set<string>();
  for (const entity of entities) {
    const scope = `${entity.organizationId}|${entity.legalEntityId}|${entity.environment}`;
    if (scopes.has(scope)) return false;
    scopes.add(scope);
    for (const invoice of entity.invoices) {
      const approval = `${entity.organizationId}|${entity.environment}|${entity.realmId}|${invoice.invoiceId}`;
      if (approvals.has(approval)) return false;
      approvals.add(approval);
    }
  }
  return true;
}

/** Parse explicit merchant readiness and scoped invoice approvals. Every omitted gate defaults off. */
export function qboHostedConfigFromEnv(env: NodeJS.ProcessEnv): QboHostedPaymentsConfig {
  const tenantCheckoutEnabled = env.RENT_OPS_TENANT_CHECKOUT_ENABLED?.trim().toLowerCase() === "true";
  const hostedPaymentsEnabled = env[ENV_ENABLED]?.trim().toLowerCase() === "true";
  const enabled = tenantCheckoutEnabled && hostedPaymentsEnabled;
  const source = env[ENV_CONFIG];
  if (!source) return { enabled: false, tenantCheckoutEnabled, configurationValid: !hostedPaymentsEnabled, entities: [] };
  if (source.length > MAX_CONFIG_CHARS) return { enabled: false, tenantCheckoutEnabled, configurationValid: false, entities: [] };
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { enabled: false, tenantCheckoutEnabled, configurationValid: false, entities: [] };
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some(key => key !== "entities") || !Array.isArray(record.entities) || record.entities.length > 10) {
      return { enabled: false, tenantCheckoutEnabled, configurationValid: false, entities: [] };
    }
    const entities = z.array(entitySchema).max(10).parse(record.entities) as QboHostedEntityConfig[];
    if (!uniqueConfig(entities)) return { enabled: false, tenantCheckoutEnabled, configurationValid: false, entities: [] };
    return { enabled, tenantCheckoutEnabled, configurationValid: true, entities };
  } catch {
    return { enabled: false, tenantCheckoutEnabled, configurationValid: false, entities: [] };
  }
}

export interface QboHostedPaymentClient extends Pick<QuickBooksAccountingClient, "read" | "query"> {
  readInvoiceWithLink(invoiceId: string): Promise<QuickBooksJsonObject | null>;
}

export interface QboHostedPaymentServiceOptions {
  readonly executor: RentOpsQueryExecutor;
  readonly config: QboHostedPaymentsConfig;
  readonly clientFor: (scope: QuickBooksConnectionScope) => QboHostedPaymentClient | null | undefined;
  readonly now?: () => Date;
}

export interface QboHostedPaymentService {
  getTenantView(input: { readonly organizationId: string; readonly identity: TenantIdentity }): Promise<QboTenantPaymentView>;
  getInvoiceLink(input: { readonly organizationId: string; readonly identity: TenantIdentity; readonly invoiceId: string }): Promise<QboTenantPaymentLink>;
  getReadiness(): QboHostedPaymentsReadiness;
}

interface TenantBindingRow {
  readonly id: unknown;
  readonly email: unknown;
  readonly person_id: unknown;
  readonly tenancy_id: unknown;
  readonly status: unknown;
}

interface PreparedTenant {
  readonly identity: TenantIdentity;
  readonly scope: QuickBooksConnectionScope;
  readonly customerId: string;
  readonly entity: QboHostedEntityConfig;
  readonly approvals: readonly QboHostedInvoiceApproval[];
  readonly localPayableCents: bigint;
  readonly localBalanceCents: bigint;
}

interface PreparedInvoice {
  readonly invoice: QboTenantPaymentInvoice;
  readonly url: string;
}

const REQUIRED_READINESS: ReadonlyArray<keyof QboHostedReadinessFlags> = [
  "enrolled", "businessVerified", "payoutBankVerified", "receiptEmailsAllowed", "receiptReconciliationVerified",
];

function readinessBlockers(readiness: QboHostedReadinessFlags): string[] {
  const labels: Record<keyof QboHostedReadinessFlags, string> = {
    enrolled: "merchant_enrollment_unverified",
    businessVerified: "business_verification_unverified",
    payoutBankVerified: "payout_bank_unverified",
    receiptEmailsAllowed: "receipt_email_permission_disabled",
    receiptReconciliationVerified: "receipt_reconciliation_unverified",
  };
  return REQUIRED_READINESS.filter(flag => readiness[flag] !== true).map(flag => labels[flag]);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = emailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function isRealEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (domain.endsWith(".test") || domain.endsWith(".invalid") || domain.endsWith(".example") || domain.endsWith(".localhost") || domain.endsWith(".local")) return false;
  return !["example.com", "example.net", "example.org"].includes(domain);
}

function identifier(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = qboIdSchema.safeParse(String(value));
  return parsed.success ? parsed.data : null;
}

function referenceId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return identifier((value as Record<string, unknown>).value);
}

function emailAddress(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return normalizeEmail((value as Record<string, unknown>).Address);
}

function hasEmailRecipient(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(hasEmailRecipient);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ("Address" in record) return hasEmailRecipient(record.Address);
  return Object.values(record).some(hasEmailRecipient);
}

/** Convert a QBO decimal lexeme to exact integer cents without a floating-point multiplication. */
function qboAmountCents(value: unknown): string | null {
  let text: string | null = null;
  if (typeof value === "string") text = value.trim();
  else if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 100) text = String(value);
  if (!text || text.length > 32) return null;
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  try {
    return (BigInt(match[1]!) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0") || "0")).toString();
  } catch { return null; }
}

/** QBO reports maxResults as the number of rows actually returned, including short first pages. */
export function qboCustomerInvoiceQueryIsComplete(response: {
  readonly entities: readonly unknown[];
  readonly startPosition?: number;
  readonly maxResults?: number;
}): boolean {
  return response.entities.length < MAX_QBO_CUSTOMER_INVOICES
    && response.startPosition === 1
    && response.maxResults === response.entities.length;
}

function safeDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) return null;
  return value;
}

function invoiceApprovalCanProveIsolation(approval: QboHostedInvoiceApproval, now: Date): boolean {
  const expiry = Date.parse(approval.expiresAt);
  return Number.isFinite(expiry) && expiry > now.getTime()
    && !/^ROP0926/i.test(approval.invoiceNumber)
    && isRealEmail(approval.tenantEmail);
}

function invoiceApprovalIsPayable(approval: QboHostedInvoiceApproval, now: Date): boolean {
  return invoiceApprovalCanProveIsolation(approval, now) && approval.balanceCents !== "0";
}

function approvalMatchesIdentity(approval: QboHostedInvoiceApproval, identity: TenantIdentity): boolean {
  return approval.tenantAccountId === identity.id
    && approval.personId === identity.personId
    && approval.tenancyId === identity.tenancyId
    && normalizeEmail(approval.tenantEmail) !== null
    && normalizeEmail(approval.tenantEmail) === normalizeEmail(identity.email);
}

function accountIdentityIsValid(identity: TenantIdentity): boolean {
  return identity.status === "active"
    && localIdSchema.safeParse(identity.id).success
    && localIdSchema.safeParse(identity.personId).success
    && localIdSchema.safeParse(identity.tenancyId).success
    && normalizeEmail(identity.email) !== null
    && isRealEmail(normalizeEmail(identity.email)!);
}

function tenantView(invoices: QboTenantPaymentInvoice[], reason?: string): QboTenantPaymentView {
  return { provider: "quickbooks", available: invoices.length > 0, reasons: invoices.length ? [] : [reason ?? "tenant_invoice_unavailable"], invoices };
}

async function accountBindingMatches(executor: RentOpsQueryExecutor, organizationId: string, identity: TenantIdentity): Promise<boolean> {
  const result = await executor.query<TenantBindingRow>(
    `SELECT a.id, a.email, a.person_id, a.tenancy_id, a.status
       FROM rent_ops_tenant_accounts a
       JOIN rent_ops_tenancies t ON t.id=a.tenancy_id
       JOIN rent_ops_people p ON p.id=a.person_id
       JOIN rent_ops_properties pr ON pr.id=t.property_id
       JOIN rent_ops_units u ON u.id=t.unit_id AND u.property_id=t.property_id
      WHERE a.id=$1 AND lower(btrim(a.email))=$2 AND a.person_id=$3 AND a.tenancy_id=$4 AND a.status='active'
        AND t.id=$4 AND t.primary_person_id=$3 AND t.status IN ('current','notice')
        AND (t.operational_end_confirmed_on IS NULL OR t.operational_end_confirmed_on > (now() AT TIME ZONE 'America/New_York')::date)
        AND p.archived IS NOT TRUE
        AND (t.status_knowledge IN ('source','manual','confirmed') OR (t.source_system IS NULL AND t.status_knowledge IS NULL))
        AND (t.primary_person_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.primary_person_link_knowledge IS NULL))
        AND (t.property_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.property_link_knowledge IS NULL))
        AND (t.unit_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.unit_link_knowledge IS NULL))
        AND (u.property_link_knowledge IN ('exact','manual') OR (u.source_system IS NULL AND u.property_link_knowledge IS NULL))
      LIMIT 2`,
    [identity.id, normalizeEmail(identity.email), identity.personId, identity.tenancyId],
  );
  const row = result.rows.length === 1 ? result.rows[0] : undefined;
  return Boolean(row
    && String(row.id) === identity.id
    && String(row.person_id) === identity.personId
    && String(row.tenancy_id) === identity.tenancyId
    && String(row.status) === "active"
    && normalizeEmail(row.email) === normalizeEmail(identity.email)
    && organizationId.length > 0);
}

async function localTenantPaymentReadiness(executor: RentOpsQueryExecutor, identity: TenantIdentity, now: Date): Promise<{ readonly ready: boolean; readonly payableCents: bigint; readonly balanceCents: bigint }> {
  const unavailable = { ready: false, payableCents: BigInt(0), balanceCents: BigInt(0) } as const;
  const reserved = await executor.query(
    `SELECT id FROM rent_ops_tenant_payments
      WHERE person_id=$1 AND tenancy_id=$2
        AND status IN ('creating','pending','processing','review_required','disputed')
      LIMIT 1`,
    [identity.personId, identity.tenancyId],
  );
  if (reserved.rows.length > 0) return unavailable;
  const snapshot = await new PostgresRentOpsRepository(executor).getOperationalSnapshot();
  const home = presentTenantHome(snapshot, identity, currentBusinessDate(now));
  if (!home || !home.balance.complete || home.balance.amountCents === null || !Number.isSafeInteger(home.balance.amountCents) || home.balance.amountCents <= 0) return unavailable;
  const accountLines = tenantAccountLedgerRows(snapshot, identity);
  if (accountLines.some(row => row.kind === "charge" && row.status === "posted" && row.payer !== "tenant")) return unavailable;
  const payable = payableAccount(snapshot, identity, [] as TenantPayment[], now);
  if (!payable.available || !Number.isSafeInteger(payable.payableCents) || payable.payableCents <= 0) return unavailable;
  return { ready: true, payableCents: BigInt(payable.payableCents), balanceCents: BigInt(home.balance.amountCents) };
}

export function createQboHostedPaymentService(options: QboHostedPaymentServiceOptions): QboHostedPaymentService {
  if (!validConfig(options.config)) throw new TypeError("QuickBooks hosted payment config is invalid");
  const now = options.now ?? (() => new Date());

  function readinessFor(entity: QboHostedEntityConfig): QboHostedEntityReadiness {
    const blockers = readinessBlockers(entity.readiness);
    if (!options.config.tenantCheckoutEnabled) blockers.unshift("tenant_checkout_disabled");
    if (!options.config.enabled && options.config.tenantCheckoutEnabled) blockers.unshift("provider_disabled");
    if (!options.config.configurationValid) blockers.unshift("provider_configuration_invalid");
    return {
      legalEntityId: entity.legalEntityId,
      ready: blockers.length === 0,
      blockers: Array.from(new Set(blockers)),
      readiness: { ...entity.readiness },
      approvedInvoiceCount: entity.invoices.length,
    };
  }

  function globalBlockers(): string[] {
    if (!options.config.configurationValid) return ["provider_configuration_invalid"];
    if (!options.config.tenantCheckoutEnabled) return ["tenant_checkout_disabled"];
    if (!options.config.enabled) return ["provider_disabled"];
    if (options.config.entities.length === 0) return ["merchant_configuration_missing"];
    return [];
  }

  async function prepareTenant(organizationId: string, identity: TenantIdentity): Promise<PreparedTenant | null> {
    if (!options.config.enabled || !options.config.tenantCheckoutEnabled || !options.config.configurationValid || !accountIdentityIsValid(identity)) return null;
    const matches = options.config.entities.filter(entity => entity.organizationId === organizationId);
    if (matches.length === 0 || !await accountBindingMatches(options.executor, organizationId, identity)) return null;
    const asOf = currentBusinessDate(now());
    const history = await resolveTenancyHistory(options.executor, { organizationId, tenancyId: identity.tenancyId, asOf });
    if (!history || history.tenancy.status !== "current" && history.tenancy.status !== "notice" || !history.effectiveLegalEntityId) return null;
    const entityMatches = matches.filter(entity => entity.legalEntityId === history.effectiveLegalEntityId && entity.environment === "production");
    if (entityMatches.length !== 1) return null;
    const entity = entityMatches[0]!;
    if (readinessBlockers(entity.readiness).length) return null;
    const source = await resolveTenancySource(options.executor, { organizationId, tenancyId: identity.tenancyId, environment: entity.environment, asOf });
    if (!source || source.ownership.state !== "resolved" || source.qbo.state !== "linked" || source.qbo.connection?.state !== "active" || source.qbo.connection.readCapabilityEnabled !== true) return null;
    const scope = source.qbo.scope;
    const customerId = source.qbo.customerLink?.customerObjectId;
    if (!scope || !customerId || scope.provider !== "qbo" || scope.environment !== entity.environment || scope.organizationId !== organizationId || scope.legalEntityId !== entity.legalEntityId || scope.realmId !== entity.realmId || source.qbo.customerLink?.legalEntityId !== entity.legalEntityId) return null;
    const approved = entity.invoices.filter(invoice => invoice.customerId === customerId
      && invoice.personId === identity.personId
      && invoice.tenancyId === identity.tenancyId
      && approvalMatchesIdentity(invoice, identity)
      && invoiceApprovalCanProveIsolation(invoice, now()));
    if (!approved.some(invoice => invoiceApprovalIsPayable(invoice, now()))) return null;
    const local = await localTenantPaymentReadiness(options.executor, identity, now());
    if (!local.ready) return null;
    return { identity, scope, customerId, entity, approvals: approved, localPayableCents: local.payableCents, localBalanceCents: local.balanceCents };
  }

  async function prepareInvoice(tenant: PreparedTenant, approval: QboHostedInvoiceApproval): Promise<PreparedInvoice | null> {
    const client = options.clientFor(tenant.scope);
    if (!client) return null;
    const [invoice, customer, customerInvoices] = await Promise.all([
      client.readInvoiceWithLink(approval.invoiceId),
      client.read("Customer", approval.customerId),
      client.query(`select * from Invoice where CustomerRef = '${approval.customerId}' STARTPOSITION 1 MAXRESULTS ${MAX_QBO_CUSTOMER_INVOICES}`),
    ]);
    if (!invoice || identifier(customer.entity.Id) !== tenant.customerId || customer.entity.Active !== true
      || !qboCustomerInvoiceQueryIsComplete(customerInvoices)) return null;
    const customerEmail = emailAddress(customer.entity.PrimaryEmailAddr);
    const authEmail = normalizeEmail(tenant.identity.email);
    if (!customerEmail || !isRealEmail(customerEmail) || customerEmail !== authEmail || customerEmail !== normalizeEmail(approval.tenantEmail)) return null;
    if (hasEmailRecipient(invoice.BillEmailCc) || hasEmailRecipient(invoice.BillEmailBcc)
      || emailAddress(invoice.BillEmail) !== authEmail
      || identifier(invoice.Id) !== approval.invoiceId
      || String(invoice.SyncToken ?? "") !== approval.invoiceSyncToken
      || referenceId(invoice.CustomerRef) !== tenant.customerId
      || String(invoice.DocNumber ?? "").trim() !== approval.invoiceNumber
      || /^ROP0926/i.test(String(invoice.DocNumber ?? "").trim())) return null;
    const balanceCents = qboAmountCents(invoice.Balance);
    const customerBalanceCents = qboAmountCents(customer.entity.Balance);
    if (balanceCents === null || balanceCents === "0" || balanceCents !== approval.balanceCents
      || customerBalanceCents !== balanceCents
      || tenant.localPayableCents.toString() !== balanceCents
      || tenant.localBalanceCents.toString() !== balanceCents) return null;
    if (invoice.CurrencyRef === undefined || referenceId(invoice.CurrencyRef) !== "USD") return null;
    const onlinePayEnabled = invoice.AllowOnlinePayment === true || invoice.AllowOnlineACHPayment === true || invoice.AllowOnlineCreditCardPayment === true;
    const invoiceLink = invoice.InvoiceLink;
    if (!onlinePayEnabled || !isQuickBooksHostedInvoiceUrl(invoiceLink)) return null;

    const invoices = new Map<string, { readonly balanceCents: string; readonly docNumber: string; readonly syncToken: string }>();
    for (const row of customerInvoices.entities) {
      const id = identifier(row.Id);
      const rowCustomer = referenceId(row.CustomerRef);
      const amount = qboAmountCents(row.Balance);
      const docNumber = typeof row.DocNumber === "string" ? row.DocNumber.trim() : "";
      const syncToken = typeof row.SyncToken === "string" ? row.SyncToken : "";
      const rowEmail = emailAddress(row.BillEmail);
      if (!id || rowCustomer !== tenant.customerId || amount === null || invoices.has(id)
        || !docNumber || /^ROP0926/i.test(docNumber)
        || referenceId(row.CurrencyRef) !== "USD"
        || hasEmailRecipient(row.BillEmailCc) || hasEmailRecipient(row.BillEmailBcc)
        || rowEmail !== authEmail) return null;
      const rowApproval = tenant.approvals.find(candidate => candidate.invoiceId === id
        && candidate.invoiceSyncToken === syncToken
        && candidate.invoiceNumber === docNumber
        && candidate.balanceCents === amount
        && candidate.customerId === tenant.customerId
        && normalizeEmail(candidate.tenantEmail) === authEmail
        && approvalMatchesIdentity(candidate, tenant.identity)
        && invoiceApprovalCanProveIsolation(candidate, now()));
      if (!rowApproval || (id !== approval.invoiceId && amount !== "0")) return null;
      invoices.set(id, { balanceCents: amount, docNumber, syncToken });
    }
    const current = invoices.get(approval.invoiceId);
    if (!current || current.balanceCents !== balanceCents || current.docNumber !== approval.invoiceNumber
      || current.syncToken !== approval.invoiceSyncToken
      || identifier(invoice.Id) !== approval.invoiceId
      || String(invoice.SyncToken ?? "") !== current.syncToken
      || referenceId(invoice.CurrencyRef) !== "USD") return null;

    const invoiceView: QboTenantPaymentInvoice = {
      id: approval.invoiceId,
      number: approval.invoiceNumber,
      balanceCents,
      dueDate: safeDate(invoice.DueDate),
    };
    return { invoice: invoiceView, url: invoiceLink };
  }

  return {
    async getTenantView(input): Promise<QboTenantPaymentView> {
      const global = globalBlockers();
      if (global.length) return tenantView([], global[0]);
      const tenant = await prepareTenant(input.organizationId, input.identity);
      if (!tenant) return tenantView([], "tenant_invoice_unavailable");
      const invoices: QboTenantPaymentInvoice[] = [];
      for (const approval of tenant.approvals.filter(row => invoiceApprovalIsPayable(row, now()))) {
        try {
          const prepared = await prepareInvoice(tenant, approval);
          if (prepared) invoices.push(prepared.invoice);
        } catch {
          // Tenant responses carry no provider error text or identifiers.
        }
      }
      return tenantView(invoices);
    },

    async getInvoiceLink(input): Promise<QboTenantPaymentLink> {
      const parsedId = qboIdSchema.safeParse(input.invoiceId);
      if (!parsedId.success) throw new QboHostedPaymentError("invoice_payment_unavailable", 404);
      if (!options.config.enabled || !options.config.configurationValid) throw new QboHostedPaymentError("qbo_hosted_payments_unavailable", 503);
      const tenant = await prepareTenant(input.organizationId, input.identity);
      const approval = tenant?.approvals.find(row => row.invoiceId === parsedId.data && invoiceApprovalIsPayable(row, now()));
      if (!tenant || !approval) throw new QboHostedPaymentError("invoice_payment_unavailable", 404);
      try {
        const prepared = await prepareInvoice(tenant, approval);
        if (!prepared) throw new QboHostedPaymentError("invoice_payment_unavailable", 404);
        return { invoiceId: approval.invoiceId, url: prepared.url };
      } catch (error) {
        if (error instanceof QboHostedPaymentError) throw error;
        throw new QboHostedPaymentError("qbo_hosted_payments_unavailable", 503);
      }
    },

    getReadiness(): QboHostedPaymentsReadiness {
      const blockers = globalBlockers();
      const entities = options.config.configurationValid ? options.config.entities.map(readinessFor) : [];
      return {
        provider: "quickbooks",
        enabled: options.config.enabled && options.config.configurationValid && entities.some(entity => entity.ready),
        blockers,
        entities,
      };
    },
  };
}

export const qboHostedPaymentEnvironment = { enabled: ENV_ENABLED, config: ENV_CONFIG } as const;
export const qboHostedPaymentEntityDefaults = { readiness: falseReadiness, invoices: [] as readonly QboHostedInvoiceApproval[] } as const;
