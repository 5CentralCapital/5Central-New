import { z } from "zod";
import { isoDateSchema, legalEntityIdSchema, organizationIdSchema } from "../company";

const providerAccountIdSchema = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/, "QuickBooks Account ID is invalid");
const accountSourceVersionSchema = z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f\u007f]+$/, "QuickBooks Account revision is invalid");
const reviewEvidenceSchema = z.string().trim().min(1).max(1_000).regex(/^[^\u0000-\u001f\u007f]+$/, "Review evidence is invalid");
const realmIdSchema = z.string().regex(/^\d{1,32}$/, "QuickBooks realm ID is invalid");

export const ACCOUNTING_PURPOSE_COMMAND_KINDS = ["accounting.qbo_purpose.map_capitalized_cost"] as const;
export type AccountingPurposeCommandKind = (typeof ACCOUNTING_PURPOSE_COMMAND_KINDS)[number];

/**
 * The command deliberately exposes only the reviewed capitalized-cost use
 * case. The caller must include the exact mirrored Account revision it
 * reviewed; the server re-reads that revision before persisting the mapping.
 */
export const mapCapitalizedCostPayloadSchema = z.object({
  providerAccountId: providerAccountIdSchema,
  accountSourceVersion: accountSourceVersionSchema,
  environment: z.enum(["sandbox", "production"]),
  realmId: realmIdSchema,
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable().optional(),
  reviewEvidence: reviewEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.effectiveTo !== undefined && value.effectiveTo !== null && value.effectiveTo <= value.effectiveFrom) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "effectiveTo must be after effectiveFrom" });
  }
});
export type MapCapitalizedCostPayload = z.infer<typeof mapCapitalizedCostPayloadSchema>;

export const accountingPurposeCommandPayloadSchemas = {
  "accounting.qbo_purpose.map_capitalized_cost": mapCapitalizedCostPayloadSchema,
} as const;

/** Scope used by the purpose-mapping directory and its browser/MCP reads. */
export const accountingPurposeScopeQuerySchema = z.object({
  organizationId: organizationIdSchema,
  legalEntityId: legalEntityIdSchema,
  environment: z.enum(["sandbox", "production"]),
  realmId: realmIdSchema,
  providerAccountId: providerAccountIdSchema.optional(),
}).strict();
