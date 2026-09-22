import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  financialAccountingPurposeMappingSchema,
  financialProviderAccountingPurposeSchema,
  financialSourceScopeSchema,
  type FinancialAccountingPurposeMapping,
  type FinancialAccountingPurposeMappingReadPort,
  type FinancialProviderAccountingPurpose,
  type FinancialSourceScope,
} from "../../shared/accounting";
import { isoDateSchema, isoTimestampSchema } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { AccountingError } from "./errors";

const mappedPurposeSchema = financialProviderAccountingPurposeSchema.exclude(["unknown"]);
const providerAccountIdSchema = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const reviewEvidenceSchema = z.string().trim().min(1).max(1_000).regex(/^[^\u0000-\u001f\u007f]+$/);
const actorIdSchema = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);

export interface AccountingPurposeMappingInput {
  readonly scope: FinancialSourceScope;
  readonly providerAccountId: string;
  readonly purpose: Exclude<FinancialProviderAccountingPurpose, "unknown">;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string | null;
  /** Human review evidence; this must name the supporting source, not an account name heuristic. */
  readonly reviewEvidence: string;
  readonly actorId: string;
}

export interface AccountingPurposeMappingPort extends FinancialAccountingPurposeMappingReadPort {
  forExecutor(executor: RentOpsQueryExecutor): AccountingPurposeMappingPort;
  mapPurpose(input: AccountingPurposeMappingInput): Promise<FinancialAccountingPurposeMapping>;
  listPurposeMappings(scope: FinancialSourceScope, providerAccountId?: string): Promise<readonly FinancialAccountingPurposeMapping[]>;
}

interface MappingRow {
  id: unknown;
  organization_id: unknown;
  legal_entity_id: unknown;
  environment: unknown;
  realm_id: unknown;
  provider_account_id: unknown;
  purpose: unknown;
  effective_from: unknown;
  effective_to: unknown;
  account_source_version: unknown;
  account_type: unknown;
  account_subtype: unknown;
  review_evidence: unknown;
  reviewed_by: unknown;
  reviewed_at: unknown;
  created_at: unknown;
}

interface ProviderAccountRow {
  object_version: unknown;
  provider_body: unknown;
  provider_updated_at: unknown;
}

function scopeParts(scope: FinancialSourceScope): unknown[] {
  return [scope.organizationId, scope.legalEntityId, scope.environment, scope.realmId];
}

function dateValue(value: unknown, field: string): string {
  const candidate = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  const parsed = isoDateSchema.safeParse(candidate);
  if (!parsed.success) throw new AccountingError("accounting_unavailable", `Accounting purpose mapping returned an invalid ${field}`);
  return parsed.data;
}

function timestampValue(value: unknown, field: string): string {
  const candidate = value instanceof Date ? value.toISOString() : value;
  const parsed = isoTimestampSchema.safeParse(candidate);
  if (!parsed.success) throw new AccountingError("accounting_unavailable", `Accounting purpose mapping returned an invalid ${field}`);
  return parsed.data;
}

function textValue(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AccountingError("accounting_unavailable", `Accounting purpose mapping returned an invalid ${field}`);
  }
  return value;
}

function nullableTextValue(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return textValue(value, field, max);
}

function accountClassification(body: unknown): { accountType: string; accountSubType: string | null } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.AccountType !== "string" || record.AccountType.trim().length === 0) return null;
  const subtype = record.AccountSubType ?? record.DetailType;
  if (subtype !== undefined && subtype !== null && typeof subtype !== "string") return null;
  return { accountType: record.AccountType, accountSubType: subtype === undefined || subtype === null ? null : subtype };
}

function mapRow(row: MappingRow): FinancialAccountingPurposeMapping {
  return financialAccountingPurposeMappingSchema.parse({
    id: textValue(row.id, "mapping ID", 200),
    scope: financialSourceScopeSchema.parse({
      provider: "qbo",
      organizationId: textValue(row.organization_id, "organization ID", 200),
      legalEntityId: textValue(row.legal_entity_id, "legal entity ID", 200),
      environment: row.environment,
      realmId: textValue(row.realm_id, "realm ID", 32),
    }),
    providerAccountId: textValue(row.provider_account_id, "provider account ID", 200),
    purpose: row.purpose,
    effectiveFrom: dateValue(row.effective_from, "effective start"),
    effectiveTo: row.effective_to === null || row.effective_to === undefined ? null : dateValue(row.effective_to, "effective end"),
    accountSourceVersion: textValue(row.account_source_version, "provider account revision", 120),
    accountType: textValue(row.account_type, "provider account type", 120),
    accountSubType: nullableTextValue(row.account_subtype, "provider account subtype", 120),
    reviewEvidence: textValue(row.review_evidence, "review evidence", 1_000),
    reviewedBy: textValue(row.reviewed_by, "reviewer", 200),
    reviewedAt: timestampValue(row.reviewed_at, "review timestamp"),
    createdAt: timestampValue(row.created_at, "creation timestamp"),
  });
}

class PostgresAccountingPurposeMappingStore implements AccountingPurposeMappingPort {
  constructor(private readonly executor: RentOpsQueryExecutor, private readonly bound = false, private readonly now: () => Date = () => new Date()) {}

  forExecutor(executor: RentOpsQueryExecutor): AccountingPurposeMappingPort {
    return new PostgresAccountingPurposeMappingStore(executor, true, this.now);
  }

  private async hasTable(): Promise<boolean> {
    const result = await this.executor.query<{ relation: unknown }>("SELECT to_regclass('public.accounting_qbo_purpose_mappings') AS relation");
    return result.rows[0]?.relation !== null && result.rows[0]?.relation !== undefined;
  }

  private async currentAccount(scope: FinancialSourceScope, providerAccountId: string): Promise<ProviderAccountRow | null> {
    const result = await this.executor.query<ProviderAccountRow>(
      `SELECT object_version, provider_body, provider_updated_at
         FROM accounting_qbo_source_objects
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
          AND object_type='Account' AND object_id=$5 AND deleted_at IS NULL
        ORDER BY provider_updated_at DESC NULLS LAST, received_at DESC, object_version DESC
        LIMIT 1`,
      [...scopeParts(scope), providerAccountId],
    );
    return result.rows[0] ?? null;
  }

  private async readInside(scope: FinancialSourceScope, providerAccountId: string, postedOn: string): Promise<FinancialAccountingPurposeMapping | null> {
    if (!(await this.hasTable())) return null;
    const result = await this.executor.query<MappingRow & { current_provider_body: unknown; current_object_version: unknown }>(
      `SELECT mapping.id, mapping.organization_id, mapping.legal_entity_id, mapping.environment,
              mapping.realm_id, mapping.provider_account_id, mapping.purpose,
              mapping.effective_from, mapping.effective_to, mapping.account_source_version,
              mapping.account_type, mapping.account_subtype, mapping.review_evidence,
              mapping.reviewed_by, mapping.reviewed_at, mapping.created_at,
              current_account.provider_body AS current_provider_body,
              current_account.object_version AS current_object_version
         FROM accounting_qbo_purpose_mappings mapping
         JOIN LATERAL (
           SELECT object_version, provider_body
             FROM accounting_qbo_source_objects
            WHERE organization_id=mapping.organization_id
              AND legal_entity_id=mapping.legal_entity_id
              AND environment=mapping.environment
              AND realm_id=mapping.realm_id
              AND object_type='Account'
              AND object_id=mapping.provider_account_id
              AND deleted_at IS NULL
            ORDER BY provider_updated_at DESC NULLS LAST, received_at DESC, object_version DESC
            LIMIT 1
         ) current_account ON current_account.object_version=mapping.account_source_version
        WHERE mapping.organization_id=$1 AND mapping.legal_entity_id=$2 AND mapping.environment=$3 AND mapping.realm_id=$4
          AND mapping.provider_account_id=$5 AND mapping.effective_from <= $6::date
          AND (mapping.effective_to IS NULL OR mapping.effective_to > $6::date)
        ORDER BY mapping.effective_from DESC, mapping.created_at DESC
        LIMIT 1`,
      [...scopeParts(scope), providerAccountId, postedOn],
    );
    const row = result.rows[0];
    if (!row) return null;
    const mapping = mapRow(row);
    const account = accountClassification(row.current_provider_body);
    if (!account || account.accountType !== mapping.accountType || account.accountSubType !== mapping.accountSubType || String(row.current_object_version) !== mapping.accountSourceVersion) return null;
    return mapping;
  }

  async readPurposeMapping(input: { readonly scope: FinancialSourceScope; readonly providerAccountId: string; readonly postedOn: string }): Promise<FinancialAccountingPurposeMapping | null> {
    const scope = financialSourceScopeSchema.parse(input.scope);
    const providerAccountId = providerAccountIdSchema.parse(input.providerAccountId);
    const postedOn = isoDateSchema.parse(input.postedOn);
    if (!this.bound && this.executor.transaction) return this.executor.transaction(transaction => new PostgresAccountingPurposeMappingStore(transaction, true, this.now).readInside(scope, providerAccountId, postedOn), { readOnly: true });
    return this.readInside(scope, providerAccountId, postedOn);
  }

  private async mapInside(input: AccountingPurposeMappingInput): Promise<FinancialAccountingPurposeMapping> {
    if (!(await this.hasTable())) throw new AccountingError("accounting_configuration", "Accounting purpose mappings are not installed");
    const scope = financialSourceScopeSchema.parse(input.scope);
    const providerAccountId = providerAccountIdSchema.parse(input.providerAccountId);
    const purpose = mappedPurposeSchema.parse(input.purpose);
    const effectiveFrom = isoDateSchema.parse(input.effectiveFrom);
    const effectiveTo = input.effectiveTo === undefined || input.effectiveTo === null ? null : isoDateSchema.parse(input.effectiveTo);
    if (effectiveTo !== null && effectiveTo <= effectiveFrom) throw new AccountingError("accounting_validation", "Accounting purpose mapping end date must be after its start date");
    const reviewEvidence = reviewEvidenceSchema.parse(input.reviewEvidence);
    const actorId = actorIdSchema.parse(input.actorId);
    const accountRow = await this.currentAccount(scope, providerAccountId);
    if (!accountRow) throw new AccountingError("accounting_not_found", "The provider Account is not mirrored for this connection");
    const account = accountClassification(accountRow.provider_body);
    if (!account) throw new AccountingError("accounting_unavailable", "The mirrored provider Account has no usable classification");
    const accountSourceVersion = textValue(accountRow.object_version, "provider account revision", 120);
    const reviewedAt = this.now().toISOString();
    const id = randomUUID();
    const inserted = await this.executor.query<{ id: unknown }>(
      `INSERT INTO accounting_qbo_purpose_mappings
        (id, organization_id, legal_entity_id, environment, realm_id, provider_account_id,
         purpose, effective_from, effective_to, account_source_version, account_type,
         account_subtype, review_evidence, reviewed_by, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (organization_id, legal_entity_id, environment, realm_id, provider_account_id, effective_from)
       DO NOTHING RETURNING id`,
      [id, ...scopeParts(scope), providerAccountId, purpose, effectiveFrom, effectiveTo, accountSourceVersion, account.accountType, account.accountSubType, reviewEvidence, actorId, reviewedAt],
    );
    const persistedId = inserted.rows[0]?.id ?? id;
    const persisted = await this.executor.query<MappingRow>(
      `SELECT id, organization_id, legal_entity_id, environment, realm_id, provider_account_id,
              purpose, effective_from, effective_to, account_source_version, account_type,
              account_subtype, review_evidence, reviewed_by, reviewed_at, created_at
         FROM accounting_qbo_purpose_mappings
        WHERE id=$1`,
      [persistedId],
    );
    const row = persisted.rows[0];
    if (!row) throw new AccountingError("accounting_conflict", "Accounting purpose mapping could not be read after save");
    const mapping = mapRow(row);
    if (mapping.scope.organizationId !== scope.organizationId || mapping.scope.legalEntityId !== scope.legalEntityId || mapping.scope.environment !== scope.environment || mapping.scope.realmId !== scope.realmId || mapping.providerAccountId !== providerAccountId || mapping.purpose !== purpose || mapping.effectiveFrom !== effectiveFrom || mapping.effectiveTo !== effectiveTo) {
      throw new AccountingError("accounting_conflict", "An accounting purpose mapping already exists for this provider Account period");
    }
    return mapping;
  }

  async mapPurpose(input: AccountingPurposeMappingInput): Promise<FinancialAccountingPurposeMapping> {
    if (!this.bound && this.executor.transaction) return this.executor.transaction(transaction => new PostgresAccountingPurposeMappingStore(transaction, true, this.now).mapInside(input), { readOnly: false });
    return this.mapInside(input);
  }

  async listPurposeMappings(input: FinancialSourceScope, providerAccountId?: string): Promise<readonly FinancialAccountingPurposeMapping[]> {
    const scope = financialSourceScopeSchema.parse(input);
    const accountId = providerAccountId === undefined ? undefined : providerAccountIdSchema.parse(providerAccountId);
    if (!(await this.hasTable())) return [];
    const result = await this.executor.query<MappingRow>(
      `SELECT id, organization_id, legal_entity_id, environment, realm_id, provider_account_id,
              purpose, effective_from, effective_to, account_source_version, account_type,
              account_subtype, review_evidence, reviewed_by, reviewed_at, created_at
         FROM accounting_qbo_purpose_mappings
        WHERE organization_id=$1 AND legal_entity_id=$2 AND environment=$3 AND realm_id=$4
          AND ($5::varchar IS NULL OR provider_account_id=$5)
        ORDER BY provider_account_id, effective_from DESC, created_at DESC`,
      [...scopeParts(scope), accountId ?? null],
    );
    return result.rows.map(mapRow);
  }
}

export function createAccountingPurposeMappingStore(executor: RentOpsQueryExecutor, now?: () => Date): AccountingPurposeMappingPort {
  return new PostgresAccountingPurposeMappingStore(executor, false, now);
}
