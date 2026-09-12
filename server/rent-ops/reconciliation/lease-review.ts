import type { RentOpsLeaseTerm, RentOpsRepository } from '../../../shared/rent-ops-contracts';
import { RentOpsService, type RentOpsAdminPatchContext } from '../services/service';
import { validateSnapshot } from '../domain/invariants';

export interface OwnerLeaseReviewInput {
  tenancyId: string; personId: string; propertyId: string; unitId: string;
  termId: string; expectedRevision: number; expectedStartOn: string; expectedEndOn: string | null;
  patch?: { contractStartOn?: string; contractEndOn?: string };
  addition?: { id: string; status: "executed" | "draft"; contractStartOn: string; contractEndOn: string; renewalOfId: string };
  evidence: { path: string; sha256: string; reference: string };
}
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
/** Caller supplies the reconciliation transaction and archived source state. Never alters occupancy or ledger. */
export async function applyOwnerLeaseReview(repository: RentOpsRepository, input: OwnerLeaseReviewInput, context: RentOpsAdminPatchContext) {
  if (!context.actorSubject?.trim() || !Number.isFinite(Date.parse(context.occurredAt))) throw new Error('Lease review requires actual operator context');
  if (!input.evidence?.path || !/^[a-f0-9]{64}$/.test(input.evidence.sha256) || !input.evidence.reference?.trim()) throw new Error('Lease evidence required');
  const before = await repository.getSnapshot();
  const tenancy = before.tenancies.find(row => row.id === input.tenancyId);
  const term = before.leaseTerms.find(row => row.id === input.termId);
  if (!tenancy || tenancy.primaryPersonId !== input.personId || tenancy.propertyId !== input.propertyId || tenancy.unitId !== input.unitId || !term || term.tenancyId !== tenancy.id) throw new Error('Lease review exact identity mismatch');
  if ((term.recordRevision ?? 1) !== input.expectedRevision || term.contractStartOn !== input.expectedStartOn || (term.contractEndOn ?? null) !== input.expectedEndOn) throw new Error('Lease review before-state changed');
  if ((!input.patch || !Object.keys(input.patch).length) && !input.addition) throw new Error('Empty lease review');
  if (input.patch && (Object.keys(input.patch).some(key => !['contractStartOn', 'contractEndOn'].includes(key)) || Object.values(input.patch).some(value => !date(value)))) throw new Error('Lease review permits only exact contract dates');
  const updatedCandidate = { ...term, ...input.patch };
  if (updatedCandidate.contractEndOn && updatedCandidate.contractEndOn < updatedCandidate.contractStartOn) throw new Error('Invalid lease interval');
  let createdCandidate: RentOpsLeaseTerm | undefined;
  if (input.addition) {
    const added = input.addition;
    if (Object.keys(added).some(key => !['id', 'status', 'contractStartOn', 'contractEndOn', 'renewalOfId'].includes(key)) || !['executed', 'draft'].includes(added.status) || !added.id?.trim() || before.leaseTerms.some(row => row.id === added.id) || added.renewalOfId !== term.id || !date(added.contractStartOn) || !date(added.contractEndOn) || added.contractEndOn < added.contractStartOn) throw new Error('Invalid documented renewal');
    createdCandidate = { ...added, tenancyId: tenancy.id, monthToMonth: false, createdAt: context.occurredAt };
  }
  const candidate = { ...before, leaseTerms: before.leaseTerms.map(row => row.id === term.id ? updatedCandidate : row).concat(createdCandidate ? [createdCandidate] : []) };
  if (validateSnapshot(candidate).some(row => row.code === 'overlapping_lease_terms' && row.entityId === tenancy.id)) throw new Error('Reviewed lease overlaps another term');
  const service = new RentOpsService(repository, () => new Date(context.occurredAt));
  if (input.patch && Object.keys(input.patch).length) await service.patchRecord('lease_term', term.id, input.expectedRevision, input.patch, context);
  if (createdCandidate) await service.saveLeaseTerm(createdCandidate);
  const after = await repository.getSnapshot();
  if (JSON.stringify(after.tenancies) !== JSON.stringify(before.tenancies) || JSON.stringify(after.ledgerTransactions) !== JSON.stringify(before.ledgerTransactions)) throw new Error('Lease review changed occupancy or ledger');
  const updated = input.patch ? after.leaseTerms.find(row => row.id === term.id) : undefined;
  const created = createdCandidate ? after.leaseTerms.find(row => row.id === createdCandidate.id) : undefined;
  if (input.patch && (!updated || Object.entries(input.patch).some(([key, value]) => updated[key as keyof RentOpsLeaseTerm] !== value))) throw new Error('Lease review patch readback differs');
  if (createdCandidate && (!created || created.contractStartOn !== createdCandidate.contractStartOn || created.contractEndOn !== createdCandidate.contractEndOn || created.renewalOfId !== term.id || created.signedOn !== undefined)) throw new Error('Lease renewal readback differs');
  return { updated, created };
}
