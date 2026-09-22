import { z } from "zod";
import {
  centsSchema,
  currencyCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  type CurrencyCode,
  type IsoDate,
  type IsoTimestamp,
  type MoneyCents,
} from "../company";
import {
  financialDirectionSchema,
  financialSourceFlowSchema,
  financialSourceLineRoleSchema,
  financialPostingStateSchema,
  financialSettlementStateSchema,
  financialSourceReferenceSchema,
  financialSourceScopeSchema,
  type FinancialDirection,
  type FinancialPostingState,
  type FinancialSettlementState,
  type FinancialSourceReference,
  type FinancialSourceScope,
} from "./source";

const bodyHashSchema = z.string().regex(/^[a-f0-9]{64}$/, "Provider body hash must be SHA-256");
const providerBodySchema = z.record(z.string(), z.unknown());

/** Provider JSON is retained only on the source object; identity is relational. */
export const qboSourceObjectSchema = z.object({
  id: z.string().uuid(),
  scope: financialSourceScopeSchema,
  objectType: z.string().regex(/^[A-Z][A-Za-z0-9_]{0,119}$/),
  objectId: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(120),
  providerUpdatedAt: isoTimestampSchema.nullable(),
  bodyHash: bodyHashSchema,
  providerBody: providerBodySchema,
  receivedAt: isoTimestampSchema,
  deletedAt: isoTimestampSchema.nullable(),
}).strict();
export type QboSourceObject = z.infer<typeof qboSourceObjectSchema>;

export const qboTransactionSchema = z.object({
  id: z.string().uuid(),
  sourceObjectId: z.string().uuid(),
  scope: financialSourceScopeSchema,
  objectType: z.string().regex(/^[A-Z][A-Za-z0-9_]{0,119}$/),
  objectId: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(120),
  transactionDate: isoDateSchema,
  postingState: financialPostingStateSchema,
  currency: currencyCodeSchema,
  watermark: z.string().trim().min(1).max(255),
  updatedAt: isoTimestampSchema,
}).strict();
export type QboTransaction = z.infer<typeof qboTransactionSchema>;

export const qboTransactionLineSchema = z.object({
  id: z.string().uuid(),
  transactionId: z.string().uuid(),
  sourceObjectId: z.string().uuid(),
  source: financialSourceReferenceSchema,
  lineNumber: z.number().int().positive(),
  transactionType: z.string().regex(/^[A-Z][A-Za-z0-9_]{0,119}$/),
  direction: financialDirectionSchema,
  flow: financialSourceFlowSchema.default("unknown"),
  lineRole: financialSourceLineRoleSchema.default("unknown"),
  amountCents: centsSchema.refine((value) => BigInt(value) >= BigInt(0), "Line amount must be non-negative"),
  currency: currencyCodeSchema,
  postingState: financialPostingStateSchema,
  postedOn: isoDateSchema,
  settlementState: financialSettlementStateSchema,
  settledOn: isoDateSchema.nullable(),
  settledAmountCents: centsSchema.nullable(),
  accountObjectId: z.string().trim().min(1).max(200).nullable(),
  counterpartyObjectId: z.string().trim().min(1).max(200).nullable(),
  description: z.string().trim().max(500).nullable(),
  watermark: z.string().trim().min(1).max(255),
  updatedAt: isoTimestampSchema,
}).strict();
export type QboTransactionLine = z.infer<typeof qboTransactionLineSchema>;

export interface QboMirroredLineInput {
  readonly source: FinancialSourceReference;
  readonly transactionId: string;
  readonly lineNumber: number;
  readonly transactionType: string;
  readonly direction: FinancialDirection;
  readonly flow: z.infer<typeof financialSourceFlowSchema>;
  readonly lineRole: z.infer<typeof financialSourceLineRoleSchema>;
  readonly amountCents: MoneyCents;
  readonly currency: CurrencyCode;
  readonly postingState: FinancialPostingState;
  readonly postedOn: IsoDate;
  readonly settlementState: FinancialSettlementState;
  readonly settledOn: IsoDate | null;
  readonly settledAmountCents: MoneyCents | null;
  readonly accountObjectId: string | null;
  readonly counterpartyObjectId: string | null;
  readonly description: string | null;
  readonly watermark: string;
  readonly updatedAt: IsoTimestamp;
}
