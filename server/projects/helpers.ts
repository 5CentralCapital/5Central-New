import {
  centsFromBigInt,
  centsToBigInt,
  isoDateSchema,
  isoTimestampSchema,
  parseRevision,
  type IsoDate,
  type IsoTimestamp,
  type MoneyCents,
  type Revision,
} from "../../shared/company";
import { multiplyDecimalToCents } from "../../shared/company/money";
import { ValidationCommandError } from "../company/commands/errors";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { projectIdSchema, projectQuantitySchema, type ProjectId } from "../../shared/projects/contracts";

export function dbString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationCommandError("Project storage returned an invalid row", { reason: "invalid_project_storage_row", field });
  }
  return value;
}

export function dbNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ValidationCommandError("Project storage returned an invalid nullable row", { reason: "invalid_project_storage_row", field });
  }
  return value;
}

export function dbDate(value: unknown, field: string): IsoDate {
  const candidate = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (typeof candidate !== "string") {
    throw new ValidationCommandError("Project storage returned an invalid date", { reason: "invalid_project_storage_row", field });
  }
  return isoDateSchema.parse(candidate);
}

export function dbNullableDate(value: unknown, field: string): IsoDate | null {
  if (value === null || value === undefined) return null;
  return dbDate(value, field);
}

export function dbTimestamp(value: unknown, field: string): IsoTimestamp {
  const candidate = value instanceof Date ? value.toISOString() : value;
  if (typeof candidate !== "string") {
    throw new ValidationCommandError("Project storage returned an invalid timestamp", { reason: "invalid_project_storage_row", field });
  }
  return isoTimestampSchema.parse(candidate);
}

export function dbNullableTimestamp(value: unknown, field: string): IsoTimestamp | null {
  if (value === null || value === undefined) return null;
  return dbTimestamp(value, field);
}

/**
 * PostgreSQL bigint and PGlite both return bigint columns as strings in the
 * supported adapters. Refuse numbers here so a caller cannot silently lose
 * cents through a JavaScript number conversion.
 */
export function dbCents(value: unknown, field: string): MoneyCents {
  if (typeof value !== "string") {
    throw new ValidationCommandError("Project storage returned a non-string money value", { reason: "invalid_project_money", field });
  }
  try {
    return centsFromBigInt(centsToBigInt(value));
  } catch {
    throw new ValidationCommandError("Project storage returned invalid signed BIGINT cents", { reason: "invalid_project_money", field });
  }
}

export function dbNullableCents(value: unknown, field: string): MoneyCents | null {
  if (value === null || value === undefined) return null;
  return dbCents(value, field);
}

export function dbRevision(value: unknown, field = "record_revision"): Revision {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidationCommandError("Project storage returned an invalid revision", { reason: "invalid_project_storage_row", field });
  }
  try {
    return parseRevision(typeof value === "string" ? Number(value) : value);
  } catch {
    throw new ValidationCommandError("Project storage returned an invalid revision", { reason: "invalid_project_storage_row", field });
  }
}

export function dbCount(value: unknown, field: string): number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidationCommandError("Project storage returned an invalid count", { reason: "invalid_project_storage_row", field });
  }
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ValidationCommandError("Project storage returned an invalid count", { reason: "invalid_project_storage_row", field });
  }
  return parsed;
}

export function todayIsoDate(): IsoDate {
  return isoDateSchema.parse(new Date().toISOString().slice(0, 10));
}

export function resolveEffectiveDate(candidate?: string | null): IsoDate {
  return candidate === undefined || candidate === null ? todayIsoDate() : isoDateSchema.parse(candidate);
}

export function rateCentsToDecimalDollars(rateCents: MoneyCents): string {
  const value = centsToBigInt(rateCents);
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const text = absolute.toString().padStart(3, "0");
  const dollars = text.slice(0, -2);
  const cents = text.slice(-2);
  return `${negative ? "-" : ""}${dollars}.${cents}`;
}

export function calculateEstimatedCents(quantity: string, rateCents: MoneyCents): MoneyCents {
  const parsedQuantity = projectQuantitySchema.parse(quantity);
  return multiplyDecimalToCents(parsedQuantity, rateCentsToDecimalDollars(rateCents));
}

export function assertEstimatedCents(
  quantity: string,
  rateCents: MoneyCents,
  requested: MoneyCents | undefined,
): MoneyCents {
  const calculated = calculateEstimatedCents(quantity, rateCents);
  if (requested !== undefined && requested !== calculated) {
    throw new ValidationCommandError("estimatedCents must equal quantity multiplied by rateCents", {
      reason: "scope_item_estimate_mismatch",
      calculated,
      requested,
    });
  }
  return requested ?? calculated;
}

export function encodeProjectCursor(updatedAt: IsoTimestamp, id: ProjectId): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url");
}

export function decodeProjectCursor(value: string | undefined): { updatedAt: IsoTimestamp; id: ProjectId } | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof decoded.updatedAt !== "string" || typeof decoded.id !== "string") throw new Error("cursor_shape");
    return { updatedAt: isoTimestampSchema.parse(decoded.updatedAt), id: projectIdSchema.parse(decoded.id) };
  } catch {
    throw new ValidationCommandError("Project cursor is invalid", { reason: "invalid_project_cursor" });
  }
}

export async function assertProjectScope(
  executor: RentOpsQueryExecutor,
  scope: { organizationId: string; legalEntityId?: string; propertyId?: string },
  projectId: string,
  asOf: IsoDate,
): Promise<{ legalEntityId: string; propertyId: string; unitId: string | null; currency: string; recordRevision: Revision; status: string; startOn: string | null; targetOn: string | null; plannedScope: boolean }> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT p.legal_entity_id, p.property_id, p.unit_id, p.currency, p.record_revision, p.status, p.start_on, p.target_on,
            (
              p.status = 'planning' AND p.unit_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM company_property_entity_periods legal_period
                 WHERE legal_period.organization_id = p.organization_id
                   AND legal_period.legal_entity_id = p.legal_entity_id
                   AND legal_period.property_id = p.property_id
                   AND legal_period.effective_from <= $5::date
                   AND (legal_period.effective_until IS NULL OR legal_period.effective_until > $5::date)
              )
              AND EXISTS (
                SELECT 1 FROM company_project_property_plans plan
                 WHERE plan.organization_id = p.organization_id
                   AND plan.legal_entity_id = p.legal_entity_id
                   AND plan.property_id = p.property_id
                   AND plan.status = 'planned'
                   AND plan.assignment_start_on <= $5::date
              )
            ) AS planned_scope
       FROM company_projects p
      WHERE p.id = $1
        AND p.organization_id = $2
        AND ($3::uuid IS NULL OR p.legal_entity_id = $3)
        AND ($4::varchar IS NULL OR p.property_id = $4)
        AND (
          EXISTS (
            SELECT 1 FROM company_property_entity_periods pep
             WHERE pep.organization_id = p.organization_id
               AND pep.legal_entity_id = p.legal_entity_id
               AND pep.property_id = p.property_id
               AND pep.effective_from <= $5::date
               AND (pep.effective_until IS NULL OR pep.effective_until > $5::date)
          )
          OR (
            p.status = 'planning' AND p.unit_id IS NULL
            AND EXISTS (
              SELECT 1 FROM company_project_property_plans plan
               WHERE plan.organization_id = p.organization_id
                 AND plan.legal_entity_id = p.legal_entity_id
                 AND plan.property_id = p.property_id
                 AND plan.status = 'planned'
                 AND plan.assignment_start_on <= $5::date
            )
          )
        )`,
    [projectId, scope.organizationId, scope.legalEntityId ?? null, scope.propertyId ?? null, asOf],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Project was not found in the requested company scope", { reason: "project_not_found" });
  return {
    legalEntityId: dbString(row.legal_entity_id, "legal_entity_id"),
    propertyId: dbString(row.property_id, "property_id"),
    unitId: dbNullableString(row.unit_id, "unit_id"),
    currency: dbString(row.currency, "currency"),
    recordRevision: dbRevision(row.record_revision),
    status: dbString(row.status, "status"),
    startOn: dbNullableDate(row.start_on, "start_on"),
    targetOn: dbNullableDate(row.target_on, "target_on"),
    plannedScope: row.planned_scope === true || row.planned_scope === "t",
  };
}

/** Resolve a whole-property planning association without opening legal or rental scope. */
export async function assertPlannedProjectProperty(
  executor: RentOpsQueryExecutor,
  input: { organizationId: string; legalEntityId: string; propertyId: string; effectiveDate: IsoDate },
): Promise<{ currency: string }> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT le.currency
       FROM company_project_property_plans plan
       JOIN company_legal_entities le
         ON le.organization_id = plan.organization_id AND le.id = plan.legal_entity_id
       JOIN company_organizations o ON o.id = plan.organization_id
       JOIN rent_ops_properties p ON p.id = plan.property_id
      WHERE plan.organization_id = $1
        AND plan.legal_entity_id = $2
        AND plan.property_id = $3
        AND plan.status = 'planned'
        AND plan.assignment_start_on <= $4::date
        AND le.archived_at IS NULL AND o.archived_at IS NULL
        AND p.state_status <> 'archived'
      LIMIT 1`,
    [input.organizationId, input.legalEntityId, input.propertyId, input.effectiveDate],
  );
  const row = result.rows[0];
  if (!row) throw new ValidationCommandError("Property does not have a planned project association on the effective date", { reason: "planned_property_mapping" });
  return { currency: dbString(row.currency, "planned_property_currency") };
}

/** Planning project writes may use a planned association only for a whole-property planning record. */
export async function assertProjectPropertyAccess(
  executor: RentOpsQueryExecutor,
  input: { organizationId: string; legalEntityId: string; propertyId: string; unitId?: string | null; status: string; effectiveDate: IsoDate },
): Promise<{ currency: string; plannedScope: boolean }> {
  if (input.status === "planning" && (input.unitId === undefined || input.unitId === null)) {
    try {
      const legal = await assertEntityPropertyUnit(executor, input);
      return { ...legal, plannedScope: false };
    } catch (error) {
      if (!(error instanceof ValidationCommandError) || error.details.reason !== "property_entity_mapping") throw error;
      const planned = await assertPlannedProjectProperty(executor, input);
      return { ...planned, plannedScope: true };
    }
  }
  return { ...(await assertEntityPropertyUnit(executor, input)), plannedScope: false };
}

export async function assertEntityPropertyUnit(
  executor: RentOpsQueryExecutor,
  input: {
    organizationId: string;
    legalEntityId: string;
    propertyId: string;
    unitId?: string | null;
    effectiveDate: IsoDate;
  },
): Promise<{ currency: string }> {
  // Property/entity-period writers fence this same tuple. A stale ownership
  // snapshot must retry before a project mutation can commit against it.
  await executor.query('UPDATE rent_ops_properties SET record_revision = record_revision WHERE id = $1', [input.propertyId]);
  const propertyResult = await executor.query<Record<string, unknown>>(
    `SELECT le.currency
       FROM company_legal_entities le
       JOIN company_organizations o ON o.id = le.organization_id
       JOIN company_property_entity_periods pep
         ON pep.organization_id = le.organization_id
        AND pep.legal_entity_id = le.id
      JOIN rent_ops_properties p ON p.id = pep.property_id
      WHERE le.organization_id = $1
        AND le.id = $2
        AND le.archived_at IS NULL AND o.archived_at IS NULL
        AND pep.property_id = $3
        AND pep.effective_from <= $4::date
        AND (pep.effective_until IS NULL OR pep.effective_until > $4::date)
        AND p.state_status <> 'archived'
      LIMIT 1`,
    [input.organizationId, input.legalEntityId, input.propertyId, input.effectiveDate],
  );
  const row = propertyResult.rows[0];
  if (!row) {
    throw new ValidationCommandError("Property is not mapped to the legal entity on the effective date", { reason: "property_entity_mapping" });
  }
  const currency = dbString(row.currency, "currency");
  if (input.unitId !== undefined && input.unitId !== null) {
    const unitResult = await executor.query<Record<string, unknown>>(
      `SELECT id FROM rent_ops_units WHERE id = $1 AND property_id = $2`,
      [input.unitId, input.propertyId],
    );
    if (unitResult.rows.length !== 1) {
      throw new ValidationCommandError("Unit does not belong to the selected property", { reason: "unit_property_ownership" });
    }
  }
  return { currency };
}

export async function assertScopeItemForProject(
  executor: RentOpsQueryExecutor,
  input: { organizationId: string; projectId: string; scopeItemId: string },
): Promise<void> {
  const result = await executor.query(
    `SELECT 1
       FROM company_project_scope_items
      WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND archived_at IS NULL`,
    [input.organizationId, input.projectId, input.scopeItemId],
  );
  if (result.rows.length !== 1) throw new ValidationCommandError("Scope item is not part of the selected project", { reason: "scope_item_project_mismatch" });
}
