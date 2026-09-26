import { z } from "zod";
import { currencyCodeSchema } from "./money";

const entityName = z.string().trim().min(1).max(200);

export const LEGAL_ENTITY_TYPES = ["llc", "corporation", "partnership", "individual", "other", "unknown"] as const;
export const legalEntityTypeSchema = z.enum(LEGAL_ENTITY_TYPES);
export type LegalEntityType = (typeof LEGAL_ENTITY_TYPES)[number];

/** Organization-level entity setup intentionally contains no ownership, EIN, or provider fields. */
export const legalEntityCreatePayloadSchema = z.object({
  name: entityName,
  entityType: legalEntityTypeSchema,
  currency: currencyCodeSchema,
}).strict();
export type LegalEntityCreatePayload = z.output<typeof legalEntityCreatePayloadSchema>;

export const LEGAL_ENTITY_COMMAND_KINDS = ["legal_entity.create"] as const;
export type LegalEntityCommandKind = (typeof LEGAL_ENTITY_COMMAND_KINDS)[number];

export const legalEntityCommandPayloadSchemas = {
  "legal_entity.create": legalEntityCreatePayloadSchema,
} as const;
