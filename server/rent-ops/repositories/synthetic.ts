import { isSourceAllocationReversal } from "../domain/invariants";
import type {
  RentOpsActivityEvent,
  RentOpsApplicationRecord,
  RentOpsApplicationRequirement,
  RentOpsApplicationCase,
  RentOpsApplicationHistorySnapshot,
  RentOpsApplicationHouseholdMember,
  RentOpsDocument,
  RentOpsHouseholdMembership,
  RentOpsChargeDefinition,
  RentOpsLeaseTerm,
  RentOpsLedgerTransaction,
  RentOpsPaymentAllocation,
  RentOpsPerson,
  RentOpsProperty,
  RentOpsRecurringChargeSchedule,
  RentOpsRepository,
  RentOpsRecordChange,
  RentOpsRecordPatchUpdate,
  RentOpsSecurityDeposit,
  RentOpsSnapshot,
  RentOpsSubsidyContract,
  RentOpsSubsidyTenant,
  RentOpsSubsidyPayment,
  RentOpsTenancy,
  RentOpsUnit,
  RentOpsTransactionOptions,
} from "../../../shared/rent-ops-contracts";
import { assertPositiveCents, assertCents, assertValidSnapshot, documentReferenceViolations, assertPrivateStorageKey, RentOpsInvariantError } from "../domain/invariants";
import { emptyRentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { applicationHistoryCase } from "../application-history/projection";
import { assertValidApplicationHistory } from "../domain/application-history";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function upsert<T extends { id: string }>(items: T[], value: T): T {
  const index = items.findIndex((item) => item.id === value.id);
  if (index === -1) items.push(clone(value));
  else items[index] = clone(value);
  return clone(value);
}

function immutableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireOwnFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (fields.some((field) => !Object.prototype.hasOwnProperty.call(value, field))) throw new RentOpsInvariantError(`${label} v8 row is incomplete`);
}

function assertImportedChargeDefinition(value: RentOpsChargeDefinition): void {
  if (!value.source) return;
  requireOwnFields(value as unknown as Record<string, unknown>, ["displayName", "displayNameKnowledge", "category", "categoryKnowledge", "active", "activeKnowledge", "recordRevision", "sourceArtifactSha256", "artifactObservationOn"], "Charge definition");
  if (!value.source.system || !value.source.sourceId || !value.sourceArtifactSha256 || !/^[a-f0-9]{64}$/.test(value.sourceArtifactSha256) || !value.artifactObservationOn) throw new RentOpsInvariantError("Imported charge definition artifact provenance is incomplete");
}

function assertImportedSchedule(value: RentOpsRecurringChargeSchedule): void {
  if (!value.source) return;
  requireOwnFields(value as unknown as Record<string, unknown>, [
    "scopeType", "scopeId", "scopeTypeKnowledge", "scopeLinkKnowledge", "chargeDefinitionId", "chargeDefinitionKey", "tenancyId", "personId", "propertyId", "unitId", "category", "categoryKnowledge", "description", "descriptionKnowledge", "amountCents", "amountKnowledge", "effectiveFrom", "effectiveFromKnowledge", "effectiveTo", "active", "activeKnowledge", "sourceConfidence", "chargeDefinitionKnowledge", "chargeDefinitionLinkKnowledge", "sourceArtifactSha256", "artifactObservationOn", "lineageRootId", "lineageRootOrigin", "versionOrigin", "supersedesId", "versionAction", "recordRevision",
  ], "Recurring schedule");
}

function assertImportedLedger(value: RentOpsLedgerTransaction): void {
  if (!value.source) return;
  requireOwnFields(value as unknown as Record<string, unknown>, ["propertyId", "unitId", "tenancyId", "personId", "kind", "category", "categoryKnowledge", "status", "amountCents", "postedOn", "dueOn", "paymentMethod", "paymentMethodKnowledge", "description", "reversalOfId", "payer", "payerKnowledge", "adjustmentDirection", "propertyLinkKnowledge", "unitLinkKnowledge", "tenancyLinkKnowledge", "personLinkKnowledge", "amountKnowledge", "postedOnKnowledge", "dueOnKnowledge", "descriptionKnowledge", "statusKnowledge", "allocationMode", "chargeDefinitionId", "chargeDefinitionLinkKnowledge", "sourceArtifactSha256", "artifactObservationOn"], "Ledger transaction");
  if (!value.source.system || !value.source.sourceId || !value.sourceArtifactSha256 || !/^[a-f0-9]{64}$/.test(value.sourceArtifactSha256) || !value.artifactObservationOn) throw new RentOpsInvariantError("Imported ledger artifact provenance is incomplete");
}

function assertImportedAllocation(value: RentOpsPaymentAllocation): void {
  if (!value.source) return;
  requireOwnFields(value as unknown as Record<string, unknown>, ["paymentTransactionId", "chargeTransactionId", "amountCents", "allocatedOn", "paymentLinkKnowledge", "chargeLinkKnowledge", "amountKnowledge", "allocatedOnKnowledge"], "Payment allocation");
  if (!value.source.system || !value.source.sourceId) throw new RentOpsInvariantError("Imported payment allocation source provenance is incomplete");
}

function assertRecurringRoot(value: RentOpsRecurringChargeSchedule): void {
  if (value.amountCents === undefined || value.lineageRootId === undefined || value.lineageRootOrigin === undefined || value.versionOrigin === undefined || value.versionAction === undefined) {
    throw new RentOpsInvariantError("Recurring schedule v8 row is incomplete");
  }
  if (value.versionAction !== "root" || value.supersedesId !== undefined && value.supersedesId !== null) {
    throw new RentOpsInvariantError("Recurring schedule root must have versionAction root and no predecessor");
  }
  const hasSourcePair = Boolean(value.source?.system?.trim() && value.source?.sourceId?.trim());
  if (value.versionOrigin === "artifact") {
    if (value.lineageRootOrigin !== "artifact" || !hasSourcePair || !value.sourceArtifactSha256 || !value.artifactObservationOn) throw new RentOpsInvariantError("Artifact recurring schedule root requires source and artifact provenance");
  } else if (value.versionOrigin === "manual") {
    if (value.lineageRootOrigin !== "manual" || value.source || value.sourceArtifactSha256 !== undefined && value.sourceArtifactSha256 !== null || value.artifactObservationOn !== undefined && value.artifactObservationOn !== null) throw new RentOpsInvariantError("Manual recurring schedule root cannot carry artifact provenance");
  } else {
    throw new RentOpsInvariantError("Recurring schedule version origin is invalid");
  }
  if (value.amountCents !== null) assertPositiveCents(value.amountCents, "recurring schedule amountCents");
}

function assertRecurringSuccessor(
  predecessor: RentOpsRecurringChargeSchedule,
  successor: RentOpsRecurringChargeSchedule,
  expectedRevision: number,
): void {
  if (successor.id === predecessor.id || successor.supersedesId !== predecessor.id) throw new RentOpsInvariantError("Recurring schedule successor must supersede its predecessor");
  if (successor.lineageRootId !== predecessor.lineageRootId || successor.lineageRootOrigin !== predecessor.lineageRootOrigin) throw new RentOpsInvariantError("Recurring schedule lineage is immutable");
  if (successor.versionOrigin !== "manual" || successor.source || successor.sourceArtifactSha256 !== predecessor.sourceArtifactSha256 || successor.artifactObservationOn !== predecessor.artifactObservationOn) throw new RentOpsInvariantError("Recurring schedule successor provenance is invalid");
  for (const field of [
    "scopeType", "scopeId", "scopeTypeKnowledge", "scopeLinkKnowledge", "chargeDefinitionId", "chargeDefinitionKey",
    "chargeDefinitionKnowledge", "chargeDefinitionLinkKnowledge", "tenancyId", "personId", "propertyId", "unitId",
    "category", "categoryKnowledge", "description", "descriptionKnowledge",
    "sourceConfidence", "sourceArtifactSha256", "artifactObservationOn", "lineageRootId", "lineageRootOrigin",
  ] as const) {
    if (!Object.is(successor[field], predecessor[field])) throw new RentOpsInvariantError("Recurring schedule successor changed immutable fields");
  }
  if (successor.versionAction === "root") throw new RentOpsInvariantError("Recurring schedule successor cannot be a root");
  if (successor.effectiveFromKnowledge !== "manual") throw new RentOpsInvariantError("Recurring schedule successor effectiveFrom must be manual");
  if (predecessor.effectiveFrom && (!successor.effectiveFrom || successor.effectiveFrom < predecessor.effectiveFrom || (successor.effectiveFrom === predecessor.effectiveFrom && successor.versionAction !== "end"))) throw new RentOpsInvariantError("Only a terminal end may share its predecessor start");
  if (predecessor.effectiveTo && successor.effectiveFrom && successor.effectiveFrom > predecessor.effectiveTo) throw new RentOpsInvariantError("Recurring schedule successor starts after predecessor end");
  if (successor.effectiveFrom === predecessor.effectiveFrom && predecessor.lineageRootOrigin === "artifact" && (!predecessor.artifactObservationOn || !successor.effectiveFrom || successor.effectiveFrom < predecessor.artifactObservationOn)) throw new RentOpsInvariantError("Same-start end is outside its verified artifact boundary");
  if (successor.recordRevision !== expectedRevision + 1) throw new RentOpsInvariantError("Recurring schedule successor revision is stale");
  if (successor.versionAction === "replace" && (successor.effectiveTo !== predecessor.effectiveTo || successor.active !== predecessor.active || successor.activeKnowledge !== predecessor.activeKnowledge)) throw new RentOpsInvariantError("Recurring schedule successor changed immutable fields");
  if (successor.versionAction === "end" && (successor.amountCents !== null || successor.amountKnowledge !== "unknown" || successor.active !== false || successor.activeKnowledge !== "manual" || successor.effectiveTo !== successor.effectiveFrom)) {
    throw new RentOpsInvariantError("Recurring schedule end successor must be terminal");
  }
  if (successor.amountCents !== null && successor.amountCents !== undefined) assertPositiveCents(successor.amountCents, "recurring schedule amountCents");
}

const recurringChangeFields = new Set([
  "billingFrequency",
  "scopeType", "scopeId", "scopeTypeKnowledge", "scopeLinkKnowledge", "chargeDefinitionId", "chargeDefinitionKey",
  "tenancyId", "personId", "propertyId", "unitId", "category", "categoryKnowledge", "description", "descriptionKnowledge",
  "amountCents", "amountKnowledge", "effectiveFrom", "effectiveFromKnowledge", "effectiveTo", "active", "activeKnowledge",
  "sourceConfidence", "chargeDefinitionKnowledge", "chargeDefinitionLinkKnowledge", "artifactObservationOn", "lineageRootId",
  "lineageRootOrigin", "versionOrigin", "supersedesId", "versionAction", "recordRevision",
]);

function assertRecurringChange(change: RentOpsRecordChange, successor: RentOpsRecurringChargeSchedule): void {
  if (change.entityType !== "recurring_schedule" || change.targetId !== successor.id || change.revision !== successor.recordRevision) throw new RentOpsInvariantError("Recurring schedule change record target is invalid");
  if (change.changedFields.length === 0 || change.changedFields.length > 64) throw new RentOpsInvariantError("Recurring schedule change field list is invalid");
  const sorted = [...change.changedFields].sort();
  if (sorted.some((field, index) => field !== change.changedFields[index] || !recurringChangeFields.has(field)) || new Set(change.changedFields).size !== change.changedFields.length) throw new RentOpsInvariantError("Recurring schedule change field list is invalid");
  if (change.origin === "admin" && !change.actorSubject) throw new RentOpsInvariantError("Recurring schedule admin change actor is required");
}

export class SyntheticRentOpsRepository implements RentOpsRepository {
  private transactionTail: Promise<void> = Promise.resolve();
  private state: RentOpsSnapshot;
  private recordChanges: RentOpsRecordChange[];

  constructor(initial: RentOpsSnapshot = emptyRentOpsSnapshot()) {
    this.state = clone(initial);
    this.recordChanges = [];
    assertValidSnapshot(this.state);
    if (this.state.applicationHistory) assertValidApplicationHistory(this.state.applicationHistory);
  }

  async transaction<T>(work: (repository: RentOpsRepository) => Promise<T>, _options?: RentOpsTransactionOptions): Promise<T> {
    const preceding = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await preceding;
    try {
    const staged = new SyntheticRentOpsRepository(this.state);
    staged.recordChanges = clone(this.recordChanges);
    const result = await work(staged);
    const committed = await staged.getSnapshot();
    assertValidSnapshot(committed);
    if (committed.applicationHistory) assertValidApplicationHistory(committed.applicationHistory);
    this.state = committed;
    this.recordChanges = clone(staged.recordChanges);
    return result;
    } finally { release(); }
  }

  async getSnapshot(): Promise<RentOpsSnapshot> {
    return clone(this.state);
  }

  async saveProperty(property: RentOpsProperty): Promise<RentOpsProperty> {
    return upsert(this.state.properties, property);
  }

  async saveUnit(unit: RentOpsUnit): Promise<RentOpsUnit> {
    return upsert(this.state.units, unit);
  }

  async savePerson(person: RentOpsPerson): Promise<RentOpsPerson> {
    return upsert(this.state.people, person);
  }

  async saveHouseholdMembership(membership: RentOpsHouseholdMembership): Promise<RentOpsHouseholdMembership> {
    return upsert(this.state.householdMemberships, membership);
  }

  async getApplicationById(id: string): Promise<RentOpsApplicationRecord | undefined> {
    const application = this.state.applications.find((candidate) => candidate.id === id);
    return application ? clone(application) : undefined;
  }

  async getApplicationByResumeTokenHash(hash: string): Promise<RentOpsApplicationRecord | undefined> {
    const application = this.state.applications.find((candidate) => candidate.resumeTokenHash === hash);
    return application ? clone(application) : undefined;
  }

  async getApplicationHistoryCaseById(id: string): Promise<RentOpsApplicationCase | undefined> {
    if (!this.state.applicationHistory) return undefined;
    const result = applicationHistoryCase(this.state.applicationHistory, id);
    return result ? clone(result) : undefined;
  }

  async saveApplicationHistory(history: RentOpsApplicationHistorySnapshot): Promise<void> {
    assertValidApplicationHistory(history);
    if (this.state.applicationHistory) {
      if (!immutableEqual(this.state.applicationHistory, history)) throw new RentOpsInvariantError("Application history is immutable; an existing projection has a different payload");
      return;
    }
    this.state.applicationHistory = clone(history);
  }

  async saveApplication(application: RentOpsApplicationRecord): Promise<RentOpsApplicationRecord> {
    return upsert(this.state.applications, application);
  }

  async saveApplicationHouseholdMember(member: RentOpsApplicationHouseholdMember): Promise<RentOpsApplicationHouseholdMember> {
    return upsert(this.state.applicationHouseholdMembers, member);
  }

  async saveApplicationRequirement(requirement: RentOpsApplicationRequirement): Promise<RentOpsApplicationRequirement> {
    return upsert(this.state.applicationRequirements, requirement);
  }

  async saveTenancy(tenancy: RentOpsTenancy): Promise<RentOpsTenancy> {
    return upsert(this.state.tenancies, tenancy);
  }

  async saveLeaseTerm(term: RentOpsLeaseTerm): Promise<RentOpsLeaseTerm> {
    return upsert(this.state.leaseTerms, term);
  }

  async saveChargeDefinition(definition: RentOpsChargeDefinition): Promise<RentOpsChargeDefinition> {
    assertImportedChargeDefinition(definition);
    const existing = this.state.chargeDefinitions.find((candidate) => candidate.id === definition.id);
    if (existing) {
      if (!immutableEqual(existing, definition)) throw new RentOpsInvariantError("Charge definitions are immutable; an existing id has a different payload");
      return clone(existing);
    }
    this.state.chargeDefinitions.push(clone(definition));
    return clone(definition);
  }

  async saveRecurringSchedule(schedule: RentOpsRecurringChargeSchedule): Promise<RentOpsRecurringChargeSchedule> {
    assertImportedSchedule(schedule);
    assertRecurringRoot(schedule);
    const existing = this.state.recurringSchedules.find((candidate) => candidate.id === schedule.id);
    if (existing) {
      if (!immutableEqual(existing, schedule)) throw new RentOpsInvariantError("Recurring schedules are immutable; an existing id has a different payload");
      return clone(existing);
    }
    this.state.recurringSchedules.push(clone(schedule));
    return clone(schedule);
  }

  async saveRecurringScheduleRoot(input: { schedule: RentOpsRecurringChargeSchedule; change: RentOpsRecordChange }): Promise<RentOpsRecurringChargeSchedule> {
    const schedule = { ...input.schedule, recordRevision: input.schedule.recordRevision ?? 1 };
    if (schedule.versionOrigin !== "manual" || schedule.source || schedule.sourceArtifactSha256 !== undefined && schedule.sourceArtifactSha256 !== null || schedule.artifactObservationOn !== undefined && schedule.artifactObservationOn !== null) {
      throw new RentOpsInvariantError("Manual recurring schedule root cannot carry artifact provenance");
    }
    assertRecurringRoot(schedule);
    assertRecurringChange(input.change, schedule);
    const schedulesBefore = clone(this.state.recurringSchedules);
    const changesBefore = clone(this.recordChanges);
    try {
      const saved = await this.saveRecurringSchedule(schedule);
      await this.saveRecordChange(input.change);
      return saved;
    } catch (error) {
      this.state.recurringSchedules = schedulesBefore;
      this.recordChanges = changesBefore;
      throw error;
    }
  }

  async saveRecurringScheduleSuccessor(input: { predecessorId: string; successor: RentOpsRecurringChargeSchedule; expectedRevision: number; change: RentOpsRecordChange }): Promise<RentOpsRecurringChargeSchedule> {
    if (!input.change) throw new RentOpsInvariantError("Recurring schedule successor requires an authenticated change record");
    const schedulesBefore = clone(this.state.recurringSchedules);
    const changesBefore = clone(this.recordChanges);
    try {
      const predecessor = this.state.recurringSchedules.find((candidate) => candidate.id === input.predecessorId);
      if (!predecessor) throw new RentOpsInvariantError("Recurring schedule predecessor was not found");
      const expectedRevision = predecessor.recordRevision ?? 1;
      if (expectedRevision !== input.expectedRevision) throw new RentOpsInvariantError("Recurring schedule predecessor revision is stale");
      if (predecessor.versionAction === "end") throw new RentOpsInvariantError("Recurring schedule predecessor is terminal");
      assertRecurringSuccessor(predecessor, input.successor, input.expectedRevision);
      const existingBranch = this.state.recurringSchedules.find((candidate) => candidate.supersedesId === input.predecessorId);
      if (existingBranch) {
        if (!immutableEqual(existingBranch, input.successor)) throw new RentOpsInvariantError("Recurring schedule successor branch already exists with a different payload");
        assertRecurringChange(input.change, input.successor);
        await this.saveRecordChange(input.change);
        return clone(existingBranch);
      }
      const existingId = this.state.recurringSchedules.find((candidate) => candidate.id === input.successor.id);
      if (existingId) {
        if (!immutableEqual(existingId, input.successor)) throw new RentOpsInvariantError("Recurring schedule successor conflicts with an existing payload");
        assertRecurringChange(input.change, input.successor);
        await this.saveRecordChange(input.change);
        return clone(existingId);
      }
      this.state.recurringSchedules.push(clone(input.successor));
      assertRecurringChange(input.change, input.successor);
      await this.saveRecordChange(input.change);
      return clone(input.successor);
    } catch (error) {
      this.state.recurringSchedules = schedulesBefore;
      this.recordChanges = changesBefore;
      throw error;
    }
  }

  async saveLedgerTransaction(transaction: RentOpsLedgerTransaction): Promise<RentOpsLedgerTransaction> {
    assertImportedLedger(transaction);
    assertCents(transaction.amountCents, "ledger amountCents");
    if (transaction.amountCents < 0) throw new RentOpsInvariantError("Ledger amountCents must be non-negative");
    const existing = this.state.ledgerTransactions.find((candidate) => candidate.id === transaction.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(transaction)) {
      throw new RentOpsInvariantError("Posted ledger entries are append-only; create a reversal or adjustment");
    }
    if (!existing) this.state.ledgerTransactions.push(clone(transaction));
    return clone(transaction);
  }

  async savePaymentAllocation(allocation: RentOpsPaymentAllocation): Promise<RentOpsPaymentAllocation> {
    assertImportedAllocation(allocation);
    if (!isSourceAllocationReversal(allocation)) assertCents(allocation.amountCents, "allocation amountCents");
    if (allocation.amountCents! <= 0 && !isSourceAllocationReversal(allocation)) throw new RentOpsInvariantError("Allocation amount must be positive");
    const existing = this.state.paymentAllocations.find((candidate) => candidate.id === allocation.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(allocation)) throw new RentOpsInvariantError("Payment allocations are append-only; an existing id has a different payload");
      return clone(allocation);
    }
    const existingPair = !allocation.source && this.state.paymentAllocations.find((candidate) => !candidate.source && candidate.paymentTransactionId === allocation.paymentTransactionId && candidate.chargeTransactionId === allocation.chargeTransactionId && candidate.id !== allocation.id);
    if (existingPair) throw new RentOpsInvariantError("Payment-to-charge allocation already exists");
    return upsert(this.state.paymentAllocations, allocation);
  }

  async saveSecurityDeposit(deposit: RentOpsSecurityDeposit): Promise<RentOpsSecurityDeposit> {
    if (deposit.amountHeldCents === null) {
      if (deposit.source?.system !== "rent_manager" || !Number.isSafeInteger(deposit.sourceBalanceCents) || deposit.sourceBalanceCents! >= 0) throw new RentOpsInvariantError("Unknown held deposit requires signed source balance");
    } else { assertCents(deposit.amountHeldCents, "deposit amountHeldCents"); if (deposit.amountHeldCents < 0) throw new RentOpsInvariantError("Held deposit cannot be negative"); }
    return upsert(this.state.securityDeposits, deposit);
  }

  async saveSubsidyContract(contract: RentOpsSubsidyContract): Promise<RentOpsSubsidyContract> {
    assertCents(contract.agencyObligationCents, "agencyObligationCents");
    assertCents(contract.tenantObligationCents, "tenantObligationCents");
    if (contract.agencyObligationCents < 0 || contract.tenantObligationCents < 0) throw new RentOpsInvariantError("Housing-assistance obligations cannot be negative");
    if (contract.agencyObligationCents + contract.tenantObligationCents <= 0) throw new RentOpsInvariantError("Housing-assistance obligations must total more than zero");
    return upsert(this.state.subsidyContracts, contract);
  }

  async saveSubsidyTenant(tenant: RentOpsSubsidyTenant): Promise<RentOpsSubsidyTenant> {
    if (tenant.amountCents !== undefined) assertCents(tenant.amountCents, "subsidy tenant amountCents");
    const existing = this.state.subsidyTenants.find((candidate) => candidate.id === tenant.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(tenant)) throw new RentOpsInvariantError("SubsidyTenant projections are immutable; an existing id has a different payload");
    return existing ? clone(existing) : upsert(this.state.subsidyTenants, tenant);
  }

  async saveSubsidyPayment(payment: RentOpsSubsidyPayment): Promise<RentOpsSubsidyPayment> {
    if (payment.amountCents !== undefined) assertCents(payment.amountCents, "subsidy payment amountCents");
    const existing = this.state.subsidyPayments.find((candidate) => candidate.id === payment.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(payment)) throw new RentOpsInvariantError("SubsidyPayment projections are immutable; an existing id has a different payload");
    return existing ? clone(existing) : upsert(this.state.subsidyPayments, payment);
  }

  async saveDocument(document: RentOpsDocument): Promise<RentOpsDocument> {
    assertPrivateStorageKey(document.storageKey);
    const violations = documentReferenceViolations(this.state, document);
    if (violations.length > 0) throw new RentOpsInvariantError("Document references are invalid", violations);
    return upsert(this.state.documents, document);
  }

  async saveActivity(event: RentOpsActivityEvent): Promise<RentOpsActivityEvent> {
    const existing = this.state.activityEvents.find((candidate) => candidate.id === event.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new RentOpsInvariantError("Activity events are append-only; an existing id has a different payload");
      return clone(existing);
    }
    this.state.activityEvents.push(clone(event));
    return clone(event);
  }

  async applyRecordPatch(update: RentOpsRecordPatchUpdate): Promise<void> {
    const collections: Record<string, keyof RentOpsSnapshot> = {
      charge_definition: "chargeDefinitions",
      property: "properties",
      unit: "units",
      person: "people",
      household_membership: "householdMemberships",
      tenancy: "tenancies",
      lease_term: "leaseTerms",
      security_deposit: "securityDeposits",
      subsidy_contract: "subsidyContracts",
      application: "applications",
      document: "documents",
      activity: "activityEvents",
    };
    const collection = collections[update.entityType];
    if (!collection) throw new RentOpsInvariantError("Unknown Rent Operations patch target");
    const rows = this.state[collection] as unknown as Array<Record<string, unknown>>;
    const index = rows.findIndex((row) => row.id === update.targetId);
    if (index < 0) throw new RentOpsInvariantError("Rent Operations record not found");
    const current = rows[index];
    const currentRevision = typeof current.recordRevision === "number" ? current.recordRevision : 1;
    if (currentRevision !== update.expectedRevision) throw new RentOpsInvariantError("Rent Operations record revision is stale");
    const next = clone(current);
    for (const [column, value] of Object.entries(update.values)) {
      const camel = column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      if (update.entityType === "property" && column.startsWith("address_")) {
        const address = (next.address && typeof next.address === "object" ? next.address : {}) as Record<string, unknown>;
        address[camel.slice("address".length,).replace(/^./, (letter) => letter.toLowerCase())] = value;
        next.address = address;
      } else {
        next[camel] = value;
      }
    }
    next.recordRevision = update.nextRevision;
    rows[index] = next;
  }

  async saveRecordChange(change: RentOpsRecordChange): Promise<void> {
    if (change.changedFields.length === 0) throw new RentOpsInvariantError("Record change field list is invalid");
    const existing = this.recordChanges.find((candidate) => candidate.entityType === change.entityType && candidate.targetId === change.targetId && candidate.revision === change.revision);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(change)) throw new RentOpsInvariantError("Record change is immutable");
      return;
    }
    this.recordChanges.push(clone({ ...change, changedFields: [...change.changedFields].sort() }));
  }

  async getRecordChanges(): Promise<RentOpsRecordChange[]> {
    return clone(this.recordChanges).sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  }
}
