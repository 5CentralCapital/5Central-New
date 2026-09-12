import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { RentOpsPerson, RentOpsRecurringChargeSchedule, RentOpsRepository, RentOpsSnapshot, RentOpsSubsidyContract } from "../../../shared/rent-ops-contracts";
import { RentOpsService } from "../services/service";

export function reconciliationHash(value: unknown): string {
  const stable = (item: any): any => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, stable(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export interface ReconciliationEvidence { path: string; sha256: string; reference: string }
interface Guard { targetId: string; expectedRevision: number; beforeSha256: string; sourceId: string; evidence: ReconciliationEvidence }
export type ReconciliationOperation = (Guard & (
  { kind: "tenancy-status"; status: "past" | "cancelled" }
  | { kind: "lease-term-correction"; patch: { status: "executed"; contractEndOn: string; signedOn: string } }
  | { kind: "tenancy-future-departure"; observedOn: string; expectedMoveOutOn: string }
  | { kind: "schedule-replace"; successorId: string; effectiveFrom: string; amountCents: number; billingFrequency: "monthly" }
  | { kind: "schedule-end"; successorId: string; effectiveFrom: string }
  | { kind: "subsidy-establish"; personSourceId: string; grossRentCents: number; contract: RentOpsSubsidyContract }
  | { kind: "schedule-establish"; replacement: RentOpsRecurringChargeSchedule }
  | { kind: "schedule-rebuild"; targetTenancy?: { id: string; expectedRevision: number; beforeSha256: string }; endId: string; effectiveFrom: string; replacement: RentOpsRecurringChargeSchedule }
  | { kind: "account-facts"; facts: NonNullable<RentOpsPerson["sourceAccountFacts"]> }
)) | (Omit<Guard, "sourceId"> & { kind: "manual-schedule-replace"; sourceId?: never; successorId: string; effectiveFrom: string; amountCents: number; billingFrequency: "monthly"; targetTenancy: { id: string; sourceId: string; expectedRevision: number; beforeSha256: string } });
export interface ReconciliationManifest { id: string; actorSubject: string; occurredAt: string; operations: ReconciliationOperation[] }
export interface ReconciliationPlan { token: string; manifestHash: string; changes: Array<{ targetId: string; before: unknown; after: unknown; beforeSha256: string; afterSha256: string }>; ledgerUnchanged: true }
// Caller must derive this snapshot from the verified archived bytes using the RM mapper.
export interface ReconciliationOptions { mode: "plan" | "apply"; approvedPlanToken?: string; archivedSnapshot?: RentOpsSnapshot }
class PlannedRollback extends Error { constructor(readonly plan: ReconciliationPlan) { super("Reconciliation dry run rollback"); } }
function target(snapshot: RentOpsSnapshot, operation: ReconciliationOperation) {
  const rows = (operation.kind === "tenancy-status" || operation.kind === "tenancy-future-departure" || operation.kind === "schedule-establish" || operation.kind === "subsidy-establish") ? snapshot.tenancies : operation.kind === "account-facts" ? snapshot.people : operation.kind === "lease-term-correction" ? snapshot.leaseTerms : snapshot.recurringSchedules;
  return rows.find(row => row.id === operation.targetId);
}
function ledgerHash(snapshot: RentOpsSnapshot) {
  return reconciliationHash({ ledger: snapshot.ledgerTransactions, allocations: snapshot.paymentAllocations });
}
async function checkEvidence(manifest: ReconciliationManifest) {
  const verified = new Set<string>();
  for (const operation of manifest.operations) {
    const evidence = operation.evidence;
    if (!evidence.reference?.trim() || !/^[a-f0-9]{64}$/.test(evidence.sha256)) throw new Error("Verified source reference and hash required");
    const key = `${evidence.path}:${evidence.sha256}`;
    if (!verified.has(key) && createHash("sha256").update(await readFile(evidence.path)).digest("hex") !== evidence.sha256) throw new Error("Reconciliation evidence hash differs");
    verified.add(key);
  }
}

/** Internal operator workflow. Plan executes every guarded service action then rolls back.
 * Apply requires that plan's exact token. Neither mode calls a billing or ledger mutation API.
 */
export async function reconcileImportedRecords(repository: RentOpsRepository, manifest: ReconciliationManifest, options: ReconciliationOptions): Promise<ReconciliationPlan> {
  if (!manifest.id?.trim() || !manifest.actorSubject?.trim() || !Number.isFinite(Date.parse(manifest.occurredAt)) || !manifest.operations.length) throw new Error("Explicit reconciliation identity, actor, time and operations required");
  if (options.mode !== "plan" && options.mode !== "apply") throw new Error("Explicit plan or apply mode required");
  const ids = manifest.operations.map(operation => operation.kind === "schedule-establish" ? `establish:${operation.replacement.id}` : `target:${operation.targetId}`);
  if (new Set(ids).size !== ids.length) throw new Error("Each original target must occur once in a manifest");
  const statusTargets = new Set(manifest.operations.filter(operation => operation.kind === "tenancy-status").map(operation => operation.targetId));
  for (const operation of manifest.operations) {
    const tenancyId = (operation.kind === "schedule-establish" || operation.kind === "subsidy-establish") ? operation.targetId
      : operation.kind === "schedule-rebuild" ? operation.targetTenancy?.id ?? operation.replacement.tenancyId : operation.kind === "manual-schedule-replace" ? operation.targetTenancy.id : undefined;
    if (tenancyId && statusTargets.has(tenancyId)) throw new Error("Status corrections and schedule creation for the same tenancy require separate verified plans");
  }
  await checkEvidence(manifest);
  try {
    return await repository.transaction(async transaction => {
      const beforeSnapshot = await transaction.getSnapshot();
      const manifestHash = reconciliationHash(manifest);
      const before = manifest.operations.map(operation => {
        const row = target(beforeSnapshot, operation);
        if (operation.kind === "manual-schedule-replace") {
          const schedule = row as RentOpsRecurringChargeSchedule | undefined;
          if (operation.sourceId !== undefined || !schedule || schedule.source || schedule.sourceArtifactSha256 || schedule.artifactObservationOn
            || schedule.versionOrigin !== "manual" || schedule.lineageRootOrigin !== "manual" || schedule.versionAction !== "root" || schedule.lineageRootId !== schedule.id) throw new Error("Manual replacement requires an exact source-less manual root");
        } else if (!row || row.source?.system !== "rent_manager" || row.source.sourceId !== operation.sourceId) throw new Error(`Exact imported identity mismatch: ${operation.targetId}`);
        if (!row) throw new Error("Reconciliation target unavailable");
        if ((row.recordRevision ?? 1) !== operation.expectedRevision || reconciliationHash(row) !== operation.beforeSha256) throw new Error(`Before-state changed: ${operation.targetId}`);
        return row;
      });
      const token = reconciliationHash({ manifestHash, before, schedules: beforeSnapshot.recurringSchedules, ...(manifest.operations.some(operation => operation.kind === "subsidy-establish") ? { subsidyContracts: beforeSnapshot.subsidyContracts, people: beforeSnapshot.people, units: beforeSnapshot.units, properties: beforeSnapshot.properties } : {}) });
      if (options.mode === "apply" && options.approvedPlanToken !== token) throw new Error("Exact approved dry-run plan token required");
      const service = new RentOpsService(transaction, () => new Date(manifest.occurredAt));
      const context = { actorSubject: manifest.actorSubject, occurredAt: new Date(manifest.occurredAt).toISOString() };
      const changes: ReconciliationPlan["changes"] = [];
      for (let index = 0; index < manifest.operations.length; index++) {
        const operation = manifest.operations[index];
        let after: unknown;
        if (operation.kind === "tenancy-status") {
          if (!["past", "cancelled"].includes(operation.status)) throw new Error("Only explicit former or never-moved-in status corrections allowed");
          after = await service.patchRecord("tenancy", operation.targetId, operation.expectedRevision, { status: operation.status }, context);
        } else if (operation.kind === "lease-term-correction") {
          if (Object.keys(operation.patch).some(key => !["status", "contractEndOn", "signedOn"].includes(key)) || operation.patch.status !== "executed"
            || !/^\d{4}-\d{2}-\d{2}$/.test(operation.patch.contractEndOn) || !/^\d{4}-\d{2}-\d{2}$/.test(operation.patch.signedOn)) throw new Error("Lease correction only supports executed status and explicit signed/end dates");
          after = await service.patchRecord("lease_term", operation.targetId, operation.expectedRevision, operation.patch, context);
        } else if (operation.kind === "manual-schedule-replace") {
          const schedule = before[index] as RentOpsRecurringChargeSchedule;
          const guard = operation.targetTenancy;
          const tenancy = beforeSnapshot.tenancies.find(row => row.id === guard.id);
          if (!tenancy || tenancy.source?.system !== "rent_manager" || tenancy.source.sourceId !== guard.sourceId
            || (tenancy.recordRevision ?? 1) !== guard.expectedRevision || reconciliationHash(tenancy) !== guard.beforeSha256
            || !["current", "notice"].includes(tenancy.status) || !["source", "manual", "confirmed"].includes(tenancy.statusKnowledge ?? "")
            || !tenancy.actualMoveInOn || tenancy.actualMoveInOn > operation.effectiveFrom
            || !["source", "manual", "confirmed"].includes(tenancy.actualMoveInKnowledge ?? "")
            || (tenancy.actualMoveOutOn && tenancy.actualMoveOutOn <= operation.effectiveFrom)
            || schedule.scopeType !== "tenant" || schedule.scopeId !== tenancy.primaryPersonId || schedule.tenancyId !== tenancy.id
            || schedule.personId !== tenancy.primaryPersonId || schedule.propertyId !== tenancy.propertyId || schedule.unitId !== tenancy.unitId
            || schedule.category !== "base_rent" || schedule.active !== true || schedule.activeKnowledge !== "manual") throw new Error("Manual replacement target tenancy or root facts differ");
          after = await service.saveRecurringScheduleSuccessor(operation.targetId, { id: operation.successorId, expectedRevision: operation.expectedRevision, action: "replace", effectiveFrom: operation.effectiveFrom, amountCents: operation.amountCents, billingFrequency: operation.billingFrequency }, context);
        } else if (operation.kind === "tenancy-future-departure") {
          const tenancy = beforeSnapshot.tenancies.find(row => row.id === operation.targetId)!;
          const archived = options.archivedSnapshot?.tenancies.find(row => row.source?.system === "rent_manager" && row.source.sourceId === operation.sourceId);
          const archivedObservation = archived ? options.archivedSnapshot?.people.find(person => person.id === archived.primaryPersonId)?.sourceAccountFacts?.observedOn : undefined;
          if ((archivedObservation !== operation.observedOn) || !archived || archived.actualMoveOutOn != null || archived.expectedMoveOutOn !== operation.expectedMoveOutOn
            || archived.expectedMoveOutKnowledge !== "source" || !/^\d{4}-\d{2}-\d{2}$/.test(operation.observedOn)
            || !tenancy.actualMoveOutOn || tenancy.actualMoveOutOn !== operation.expectedMoveOutOn || operation.expectedMoveOutOn <= operation.observedOn
            || tenancy.actualMoveOutKnowledge !== "source") throw new Error("Future departure must match the corrected archived source observation");
          if (!transaction.applyRecordPatch || !transaction.saveRecordChange) throw new Error("Revision and audit persistence unavailable");
          await transaction.applyRecordPatch({ entityType: "tenancy", targetId: tenancy.id, expectedRevision: operation.expectedRevision, nextRevision: operation.expectedRevision + 1,
            values: { actual_move_out_on: null, actual_move_out_knowledge: "unknown", expected_move_out_on: operation.expectedMoveOutOn, expected_move_out_knowledge: "source" } });
          await transaction.saveRecordChange({ id: `record-change:reconciliation:${manifest.id}:${index}`, entityType: "tenancy", targetId: tenancy.id, revision: operation.expectedRevision + 1, origin: "admin", actorSubject: manifest.actorSubject, occurredAt: manifest.occurredAt, changedFields: ["actualMoveOutOn", "expectedMoveOutOn"] });
          after = { ...tenancy, actualMoveOutOn: undefined, actualMoveOutKnowledge: "unknown", expectedMoveOutOn: operation.expectedMoveOutOn, expectedMoveOutKnowledge: "source", recordRevision: operation.expectedRevision + 1 };
        } else if (operation.kind === "account-facts") {
          const person = before[index] as RentOpsPerson;
          if (person.sourceAccountFacts != null) throw new Error("Account-facts backfill cannot overwrite existing observations");
          const archived = options.archivedSnapshot?.people.find(row => row.source?.system === "rent_manager" && row.source.sourceId === operation.sourceId);
          if (!archived?.sourceAccountFacts || reconciliationHash(archived.sourceAccountFacts) !== reconciliationHash(operation.facts)) throw new Error("Account facts must exactly match the verified archived mapper result");
          if (!transaction.applyRecordPatch) throw new Error("Revision persistence unavailable");
          await transaction.applyRecordPatch({ entityType: "person", targetId: person.id, expectedRevision: operation.expectedRevision, nextRevision: operation.expectedRevision + 1, values: { source_account_facts: operation.facts } });
          after = { ...person, sourceAccountFacts: operation.facts, recordRevision: operation.expectedRevision + 1 };
        } else if (operation.kind === "schedule-replace" || operation.kind === "schedule-end") {
          after = await service.saveRecurringScheduleSuccessor(operation.targetId, { id: operation.successorId, expectedRevision: operation.expectedRevision, action: operation.kind === "schedule-end" ? "end" : "replace", effectiveFrom: operation.effectiveFrom, ...(operation.kind === "schedule-replace" ? { amountCents: operation.amountCents, billingFrequency: operation.billingFrequency } : {}) }, context);
        } else if (operation.kind === "subsidy-establish") {
          const tenancy = beforeSnapshot.tenancies.find(row => row.id === operation.targetId)!;
          const contract = operation.contract;
          const person = beforeSnapshot.people.find(row => row.id === tenancy.primaryPersonId);
          const unit = beforeSnapshot.units.find(row => row.id === tenancy.unitId);
          const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
          const observedOn = new Date(manifest.occurredAt).toISOString().slice(0, 10);
          if (!contract.id?.trim() || contract.source || contract.recordRevision != null || !contract.agencyName?.trim()
            || contract.status !== "active" || contract.statusKnowledge !== "manual"
            || !validDate(contract.effectiveFrom) || contract.effectiveFrom > observedOn
            || (contract.effectiveTo !== undefined && (!validDate(contract.effectiveTo) || contract.effectiveTo < contract.effectiveFrom || contract.effectiveTo < observedOn))
            || !Number.isSafeInteger(operation.grossRentCents) || operation.grossRentCents <= 0
            || !Number.isSafeInteger(contract.agencyObligationCents) || contract.agencyObligationCents <= 0
            || !Number.isSafeInteger(contract.tenantObligationCents) || contract.tenantObligationCents < 0
            || contract.agencyObligationCents + contract.tenantObligationCents !== operation.grossRentCents
            || !["current", "notice"].includes(tenancy.status) || !["source", "manual", "confirmed"].includes(tenancy.statusKnowledge ?? "")
            || !tenancy.actualMoveInOn || tenancy.actualMoveInOn > contract.effectiveFrom
            || !["source", "manual"].includes(tenancy.actualMoveInKnowledge ?? "")
            || (tenancy.actualMoveOutOn !== undefined && tenancy.actualMoveOutOn <= observedOn)
            || !person || person.source?.system !== "rent_manager" || person.source.sourceId !== operation.personSourceId
            || !unit || unit.propertyId !== tenancy.propertyId || !beforeSnapshot.properties.some(row => row.id === tenancy.propertyId)
            || contract.tenancyId !== tenancy.id || contract.propertyId !== tenancy.propertyId || contract.unitId !== tenancy.unitId) {
            throw new Error("Subsidy establishment requires exact current tenancy/person/property/unit, confirmed active dates and verified gross payer split");
          }
          // Pending and unknown existing contracts also block establishment: resolve them explicitly first.
          if (beforeSnapshot.subsidyContracts.some(row => row.id === contract.id || row.tenancyId === tenancy.id
            && row.effectiveFrom <= (contract.effectiveTo ?? "9999-12-31") && contract.effectiveFrom <= (row.effectiveTo ?? "9999-12-31"))) {
            throw new Error("Subsidy establishment overlaps an existing contract");
          }
          after = await service.saveSubsidyContract(contract);
        } else if (operation.kind === "schedule-establish") {
          const tenancy = beforeSnapshot.tenancies.find(row => row.id === operation.targetId)!;
          const replacement = operation.replacement;
          const effective = replacement.effectiveFrom;
          if (!effective || !["current", "notice"].includes(tenancy.status)
            || !["source", "manual", "confirmed"].includes(tenancy.statusKnowledge ?? "")
            || !tenancy.actualMoveInOn || tenancy.actualMoveInOn > effective
            || !["source", "manual", "confirmed"].includes(tenancy.actualMoveInKnowledge ?? "")
            || (tenancy.actualMoveOutOn && tenancy.actualMoveOutOn <= effective)
            || replacement.tenancyId !== tenancy.id || replacement.personId !== tenancy.primaryPersonId
            || replacement.propertyId !== tenancy.propertyId || replacement.unitId !== tenancy.unitId
            || replacement.scopeType !== "tenant" || replacement.scopeId !== tenancy.primaryPersonId
            || !["base_rent", "recurring_fee"].includes(replacement.category ?? "") || replacement.active !== true) {
            throw new Error("Establish requires an exact confirmed current tenancy and supported monthly obligation");
          }
          after = await service.saveRecurringSchedule(replacement, context);
        } else if (operation.kind === "schedule-rebuild") {
          const original = before[index] as RentOpsRecurringChargeSchedule;
          const replacement = operation.replacement;
          for (const key of ["personId", "propertyId", "unitId", "chargeDefinitionId", "category"] as const) {
            if (replacement[key] !== original[key]) throw new Error(`Rebuild cannot change identity or category: ${key}`);
          }
          if (operation.targetTenancy) {
            const guard = operation.targetTenancy;
            const tenancy = beforeSnapshot.tenancies.find(row => row.id === guard.id);
            if (!tenancy || (tenancy.recordRevision ?? 1) !== guard.expectedRevision || reconciliationHash(tenancy) !== guard.beforeSha256
              || !["current", "notice"].includes(tenancy.status) || !["source", "manual", "confirmed"].includes(tenancy.statusKnowledge ?? "")
              || !tenancy.actualMoveInOn || tenancy.actualMoveInOn > operation.effectiveFrom
              || !["source", "manual", "confirmed"].includes(tenancy.actualMoveInKnowledge ?? "")
              || (tenancy.actualMoveOutOn && tenancy.actualMoveOutOn <= operation.effectiveFrom)
              || tenancy.primaryPersonId !== original.personId || tenancy.propertyId !== original.propertyId || tenancy.unitId !== original.unitId
              || (original.tenancyId && original.tenancyId !== tenancy.id)
              || original.scopeType !== "tenant" || original.scopeId !== original.personId
              || replacement.scopeType !== "tenant" || replacement.scopeId !== tenancy.primaryPersonId || replacement.tenancyId !== tenancy.id) {
              throw new Error("Verified target tenancy binding mismatch");
            }
          } else if (replacement.scopeType !== original.scopeType || replacement.scopeId !== original.scopeId || replacement.tenancyId !== original.tenancyId) {
            throw new Error("Rebuild cannot change scope without an explicit target tenancy guard");
          }
          if (replacement.effectiveFrom !== operation.effectiveFrom || replacement.active !== true) throw new Error("Rebuild must explicitly confirm activation on the correction date");
          const ended = await service.saveRecurringScheduleSuccessor(operation.targetId, { id: operation.endId, expectedRevision: operation.expectedRevision, action: "end", effectiveFrom: operation.effectiveFrom }, context);
          const created = await service.saveRecurringSchedule(replacement, context);
          after = { ended, created };
        } else throw new Error("Unsupported reconciliation operation");
        changes.push({ targetId: operation.targetId, before: before[index], after, beforeSha256: reconciliationHash(before[index]), afterSha256: reconciliationHash(after) });
      }
      if (ledgerHash(beforeSnapshot) !== ledgerHash(await transaction.getSnapshot())) throw new Error("Reconciliation unexpectedly changed ledger or allocations");
      const plan: ReconciliationPlan = { token, manifestHash, changes, ledgerUnchanged: true };
      await transaction.saveActivity({ id: `activity:reconciliation:${manifest.id}`, type: "system", actor: "admin", occurredAt: manifest.occurredAt, summary: `Source reconciliation ${manifest.id}; actor ${manifest.actorSubject}; manifest ${manifestHash}; before/after ${reconciliationHash(changes)}; no posting.` });
      if (options.mode === "plan") throw new PlannedRollback(plan);
      return plan;
    });
  } catch (error) {
    if (error instanceof PlannedRollback && options.mode === "plan") return error.plan;
    throw error;
  }
}
