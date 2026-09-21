import { z } from "zod";
import {
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
  type LegalEntityId,
  type OrganizationId,
  type PropertyReferenceId,
} from "./identifiers";

export interface CompanyScope {
  readonly organizationId: OrganizationId;
  readonly legalEntityId?: LegalEntityId;
  readonly propertyId?: PropertyReferenceId;
}

/** A tenancy ID is intentionally absent: company scope and rental scope differ. */
export const companyScopeSchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
}).strict().refine(scope => scope.propertyId === undefined || scope.legalEntityId !== undefined, {
  path: ["legalEntityId"],
  message: "Property scope requires its legal entity",
});

export function parseCompanyScope(value: unknown): CompanyScope {
  return companyScopeSchema.parse(value);
}

export function scopeKey(scope: CompanyScope): string {
  return [
    `organization:${scope.organizationId}`,
    `legal_entity:${scope.legalEntityId ?? "*"}`,
    `property:${scope.propertyId ?? "*"}`,
  ].join("|");
}
