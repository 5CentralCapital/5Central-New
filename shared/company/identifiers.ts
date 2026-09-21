import { z } from "zod";

/**
 * Company records use canonical, lower-case RFC 4122 UUIDs for new IDs.
 * Historical rental IDs are deliberately a separate type and are never
 * coerced into this type.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type CompanyId = Brand<string, "CompanyId">;
export type RecordId = Brand<string, "RecordId">;
export type OrganizationId = Brand<string, "OrganizationId">;
export type LegalEntityId = Brand<string, "LegalEntityId">;
export type PropertyId = Brand<string, "PropertyId">;
export type PersonId = Brand<string, "PersonId">;
export type DocumentId = Brand<string, "DocumentId">;
export type OperationId = Brand<string, "OperationId">;
export type LegacyRentalId = Brand<string, "LegacyRentalId">;
export type PropertyReferenceId = PropertyId | LegacyRentalId;
export type PersonReferenceId = PersonId | LegacyRentalId;
export type DocumentReferenceId = DocumentId | LegacyRentalId;
export type RecordReferenceId = RecordId | LegacyRentalId;
export type AuthenticatedPrincipalId = Brand<string, "AuthenticatedPrincipalId">;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID.test(value);
}

export const canonicalUuidSchema = z.string().refine(
  isCanonicalUuid,
  "Expected a lower-case RFC 4122 UUID",
);

export const companyIdSchema = canonicalUuidSchema.transform((value) => value as CompanyId);
export const recordIdSchema = canonicalUuidSchema.transform((value) => value as RecordId);
export const organizationIdSchema = canonicalUuidSchema.transform((value) => value as OrganizationId);
export const legalEntityIdSchema = canonicalUuidSchema.transform((value) => value as LegalEntityId);
export const propertyIdSchema = canonicalUuidSchema.transform((value) => value as PropertyId);
export const personIdSchema = canonicalUuidSchema.transform((value) => value as PersonId);
export const documentIdSchema = canonicalUuidSchema.transform((value) => value as DocumentId);
export const operationIdSchema = canonicalUuidSchema.transform((value) => value as OperationId);

/**
 * This accepts the opaque IDs retained from the rental system without
 * changing their spelling, punctuation, or numeric representation. It is
 * intentionally not an alias of a UUID schema.
 */
export const opaqueReferenceIdSchema = z.string()
  .min(1, "Reference ID is required")
  .max(160, "Reference ID cannot exceed 160 characters")
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Reference ID cannot contain control characters");

export const legacyRentalIdSchema = opaqueReferenceIdSchema.transform((value) => value as LegacyRentalId);

/** Existing rental references remain opaque; new company references use UUIDs. */
export const propertyReferenceIdSchema = z.union([propertyIdSchema, legacyRentalIdSchema]);
export const personReferenceIdSchema = z.union([personIdSchema, legacyRentalIdSchema]);
export const documentReferenceIdSchema = z.union([documentIdSchema, legacyRentalIdSchema]);
export const recordReferenceIdSchema = z.union([recordIdSchema, legacyRentalIdSchema]);

/** Authenticated host principals are separate from rental people. */
export const authenticatedPrincipalIdSchema = opaqueReferenceIdSchema
  .transform((value) => value as AuthenticatedPrincipalId);

export function preserveLegacyRentalId(value: unknown): LegacyRentalId {
  return legacyRentalIdSchema.parse(value);
}

export function preserveLegacyPropertyId(value: unknown): LegacyRentalId {
  return legacyRentalIdSchema.parse(value);
}

export function preserveLegacyPersonId(value: unknown): LegacyRentalId {
  return legacyRentalIdSchema.parse(value);
}

export function preserveLegacyDocumentId(value: unknown): LegacyRentalId {
  return legacyRentalIdSchema.parse(value);
}

function newUuid(): string {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("A cryptographic UUID generator is required for new company IDs");
  }
  return globalThis.crypto.randomUUID();
}

export function newCompanyId(): CompanyId {
  return companyIdSchema.parse(newUuid());
}

export function newRecordId(): RecordId {
  return recordIdSchema.parse(newUuid());
}

export function newOrganizationId(): OrganizationId {
  return organizationIdSchema.parse(newUuid());
}

export function newLegalEntityId(): LegalEntityId {
  return legalEntityIdSchema.parse(newUuid());
}

export function newPropertyId(): PropertyId {
  return propertyIdSchema.parse(newUuid());
}

export function newPersonId(): PersonId {
  return personIdSchema.parse(newUuid());
}

export function newDocumentId(): DocumentId {
  return documentIdSchema.parse(newUuid());
}

export function newOperationId(): OperationId {
  return operationIdSchema.parse(newUuid());
}
