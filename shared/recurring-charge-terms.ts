import { z } from 'zod';
const id = z.string().trim().min(1).max(160);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value);
const facts = z.object({
  appliesFrom:date,
  personId:id, tenancyId:id, propertyId:id, unitId:id, amountCents:z.number().int().positive().safe(),
  verifiedRateFrom:date.nullable(), rateFromKnowledge:z.enum(['verified','unknown']),
  leaseFrom:date.nullable(), leaseFromKnowledge:z.enum(['verified','unknown']),
  leaseThrough:date.nullable(), leaseThroughKnowledge:z.enum(['verified','unknown','month_to_month']),
  evidenceReference:z.string().trim().min(1).max(1500), evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/),
});
function coherent(row:z.infer<typeof facts>,context:z.RefinementCtx) {
  for (const [value,knowledge] of [[row.verifiedRateFrom,row.rateFromKnowledge],[row.leaseFrom,row.leaseFromKnowledge],[row.leaseThrough,row.leaseThroughKnowledge]]) {
    if ((knowledge === 'verified') !== (value !== null)) context.addIssue({code:'custom',message:'Verified dates require a date; unknown and month-to-month dates require null'});
  }
  if(row.leaseFrom && row.leaseThrough && row.leaseThrough < row.leaseFrom) context.addIssue({code:'custom',message:'Lease end cannot precede lease start'});
}
export const recurringChargeTermsInputSchema = facts.extend({expectedScheduleRevision:z.number().int().positive(),expectedReviewRevision:z.number().int().nonnegative()}).strict().superRefine(coherent);
export type RecurringChargeTermsInput = z.infer<typeof recurringChargeTermsInputSchema>;
export const recurringChargeTermsObservationSchema = facts.extend({schema:z.literal('recurring_charge_terms_v1'),id,scheduleId:id,scheduleRevision:z.number().int().positive(),reviewRevision:z.number().int().positive(),reviewedBy:z.string().trim().min(1).max(240),reviewedAt:z.string().datetime()}).strict().superRefine(coherent);
export type RecurringChargeTermsObservation = z.infer<typeof recurringChargeTermsObservationSchema>;
export interface RecurringChargeTermsView {
  scheduleId:string; reviewRevision:number; latestReviewRevision:number; appliesFrom:string|null; verifiedRateFrom:string|null; rateFromKnowledge:'verified'|'unknown';
  leaseFrom:string|null; leaseFromKnowledge:'verified'|'unknown'; leaseThrough:string|null; leaseThroughKnowledge:'verified'|'unknown'|'month_to_month';
  reviewedAt:string|null;
}
