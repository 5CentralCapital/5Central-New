import { createHash } from "node:crypto";
import type { RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { reconciliationHash as hash, type ReconciliationManifest, type ReconciliationOperation, type ReconciliationPlan } from "./operator";

const collections = ["people", "tenancies", "leaseTerms", "recurringSchedules", "subsidyContracts", "units", "properties", "chargeDefinitions"] as const;
type Collection = typeof collections[number];
export interface Selector { collection: Collection; sourceId?: string; id?: string }
export interface Requirement { target: Selector; expected: Record<string, unknown> }
export interface MaintenancePhase { id: string; checks?: Requirement[]; checkGroups?: string[]; archive?: Array<Requirement>; operations: Array<{ target: Selector; expected?: Record<string, unknown>; values: Record<string, unknown>; reference: string }> }
export interface MaintenancePack { version: 1; initialBaselineSha256: string; counts: Record<string, number>; phases: MaintenancePhase[]; provenance: unknown; data?: Record<string, unknown>; checkGroups?: Record<string, Requirement[]> }
export class MaintenanceGuardError extends Error { constructor(readonly code: string) { super(code); } }
export function requireGuard(value: unknown, code: string): asserts value { if (!value) throw new MaintenanceGuardError(code); }
export const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
export function readPack(bytes: Uint8Array, expectedSha256: string): MaintenancePack {
  requireGuard(/^[a-f0-9]{64}$/.test(expectedSha256) && bytesHash(bytes) === expectedSha256, "pack_hash_mismatch");
  const pack = JSON.parse(Buffer.from(bytes).toString("utf8"));
  requireGuard(plain(pack) && pack.version === 1 && /^[a-f0-9]{64}$/.test(pack.initialBaselineSha256) && plain(pack.counts) && Array.isArray(pack.phases) && pack.phases.length > 0 && pack.provenance != null, "invalid_pack");
  requireGuard(Object.values(pack.counts).every(v => Number.isSafeInteger(v) && Number(v) >= 0), "invalid_counts");
  requireGuard(pack.phases.every((p: any) => plain(p) && typeof p.id === "string" && /^[a-zA-Z0-9_-]+$/.test(p.id) && Array.isArray(p.operations) && p.operations.length > 0), "invalid_phases");
  requireGuard(new Set(pack.phases.map((p: any) => p.id)).size === pack.phases.length, "duplicate_phase");
  return pack as unknown as MaintenancePack;
}
export function select(snapshot: RentOpsSnapshot, selector: Selector): any {
  requireGuard(plain(selector) && collections.includes(selector.collection) && ((typeof selector.sourceId === "string" && selector.id === undefined) || (typeof selector.id === "string" && selector.sourceId === undefined)), "invalid_selector");
  const rows = (snapshot[selector.collection] as any[]).filter(row => selector.sourceId !== undefined ? row.source?.system === "rent_manager" && row.source.sourceId === selector.sourceId : row.id === selector.id);
  requireGuard(rows.length === 1, "identity_not_unique");
  return rows[0];
}
/** A data-only reference language. It has no evaluation, filesystem, network, or code primitives. */
export function resolveValue(snapshot: RentOpsSnapshot, value: any, data: Record<string, unknown> = {}): any {
  if (Array.isArray(value)) return value.map(v => resolveValue(snapshot, v, data));
  if (!plain(value)) return value;
  if ("$data" in value) {
    requireGuard(Object.keys(value).length === 1 && Array.isArray(value.$data) && value.$data.length > 0 && value.$data.every((k: unknown) => typeof k === "string" && !["__proto__", "prototype", "constructor"].includes(k)), "invalid_data_reference");
    let result: any = data;
    for (const key of value.$data) { requireGuard(plain(result) && Object.hasOwn(result, key), "data_reference_missing"); result = result[key]; }
    return structuredClone(result);
  }
  if ("$ref" in value) {
    requireGuard(Object.keys(value).every(k => ["$ref", "field"].includes(k)) && typeof value.field === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(value.field), "invalid_reference");
    const row = select(snapshot, value.$ref);
    requireGuard(Object.hasOwn(row, value.field) && row[value.field] !== undefined, "reference_field_missing");
    return row[value.field];
  }
  if ("$guard" in value) {
    requireGuard(Object.keys(value).length === 1, "invalid_guard_reference");
    const row = select(snapshot, value.$guard);
    return { id: row.id, ...(row.source?.sourceId ? { sourceId: row.source.sourceId } : {}), expectedRevision: row.recordRevision ?? 1, beforeSha256: hash(row) };
  }
  requireGuard(!Object.keys(value).some(k => ["__proto__", "prototype", "constructor"].includes(k)), "invalid_object_key");
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(snapshot, v, data)]));
}
function checkFields(row: any, fields: Record<string, unknown>) {
  requireGuard(plain(fields), "invalid_expected_fields");
  for (const [key, value] of Object.entries(fields)) requireGuard(hash(row[key] ?? null) === hash(value ?? null), "expected_value_changed");
}
export function snapshotHash(snapshot: RentOpsSnapshot) {
  return hash(Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort((a, b) => String(a.id ?? hash(a)).localeCompare(String(b.id ?? hash(b)))) : v])));
}
export function buildMaintenanceManifest(snapshot: RentOpsSnapshot, pack: MaintenancePack, phase: MaintenancePhase, context: { actor: string; occurredAt: string; packPath: string; packSha256: string }): { manifest: ReconciliationManifest; archivedSnapshot: RentOpsSnapshot } {
  requireGuard(context.actor?.trim() && Number.isFinite(Date.parse(context.occurredAt)) && Date.parse(context.occurredAt) <= Date.now(), "actual_operator_context_required");
  for (const [key, count] of Object.entries(pack.counts)) requireGuard(Array.isArray((snapshot as any)[key]) && (snapshot as any)[key].length === count, "snapshot_count_changed");
  const grouped = (phase.checkGroups ?? []).flatMap(name => { const group = pack.checkGroups?.[name]; requireGuard(Array.isArray(group), "check_group_missing"); return group; });
  for (const requirement of [...grouped, ...(phase.checks ?? [])]) checkFields(select(snapshot, requirement.target), resolveValue(snapshot, requirement.expected, pack.data));
  const archivedSnapshot = structuredClone(snapshot);
  for (const record of phase.archive ?? []) Object.assign(select(archivedSnapshot, record.target), resolveValue(snapshot, record.expected, pack.data));
  const allowed = ["account-facts", "tenancy-status", "tenancy-future-departure", "schedule-establish", "lease-term-correction", "manual-schedule-replace", "subsidy-establish", "schedule-end"];
  const operations = phase.operations.map(spec => {
    requireGuard(plain(spec) && typeof spec.reference === "string" && spec.reference.trim(), "evidence_reference_required");
    const target = select(snapshot, spec.target);
    if (spec.expected) checkFields(target, resolveValue(snapshot, spec.expected, pack.data));
    const values = resolveValue(snapshot, spec.values, pack.data);
    requireGuard(allowed.includes(values.kind) && !["targetId", "expectedRevision", "beforeSha256", "sourceId", "evidence"].some(k => Object.hasOwn(values, k)), "operation_guard_override");
    requireGuard(values.kind !== "schedule-end" || spec.target.collection === "recurringSchedules", "operation_collection_mismatch");
    requireGuard(values.kind === "manual-schedule-replace" ? spec.target.collection === "recurringSchedules" && !target.source : target.source?.system === "rent_manager", "operation_source_mismatch");
    return { ...values, targetId: target.id, expectedRevision: target.recordRevision ?? 1, beforeSha256: hash(target), ...(values.kind === "manual-schedule-replace" ? {} : { sourceId: target.source.sourceId }), evidence: { path: context.packPath, sha256: context.packSha256, reference: spec.reference } } as ReconciliationOperation;
  });
  return { manifest: { id: phase.id, actorSubject: context.actor, occurredAt: context.occurredAt, operations }, archivedSnapshot };
}
export function verifyMaintenanceReadback(before: RentOpsSnapshot, after: RentOpsSnapshot, manifest: ReconciliationManifest, plan: ReconciliationPlan) {
  const indexCollections = (snapshot: RentOpsSnapshot) => new Map(Object.entries(snapshot).filter(([, rows]) => Array.isArray(rows)).map(([collection, rows]) => {
    const index = new Map((rows as any[]).map(row => [row.id, row]));
    requireGuard(index.size === (rows as any[]).length, "duplicate_record_id");
    return [collection, index] as const;
  }));
  const beforeIndexes = indexCollections(before);
  const afterIndexes = indexCollections(after);
  const changed = new Map<string, Set<string>>();
  const created = new Map<string, Set<string>>();
  for (let i = 0; i < manifest.operations.length; i++) {
    const op = manifest.operations[i];
    const collection = op.kind === "account-facts" ? "people" : op.kind === "lease-term-correction" ? "leaseTerms" : op.kind === "schedule-establish" || op.kind === "manual-schedule-replace" || op.kind === "schedule-end" ? "recurringSchedules" : op.kind === "subsidy-establish" ? "subsidyContracts" : "tenancies";
    const expected = plan.changes[i]?.after as any;
    requireGuard(expected?.id, "readback_target_missing");
    if (op.kind === "schedule-end") requireGuard(expected.id === op.successorId && expected.id !== op.targetId && expected.versionAction === "end" && expected.supersedesId === op.targetId, "readback_successor_mismatch");
    const actual = afterIndexes.get(collection)?.get(expected.id);
    requireGuard(actual, "readback_record_missing"); checkFields(actual, expected);
    if (!beforeIndexes.get(collection)?.has(expected.id)) { const ids = created.get(collection) ?? new Set<string>(); ids.add(expected.id); created.set(collection, ids); }
    if (!["schedule-establish", "manual-schedule-replace", "subsidy-establish", "schedule-end"].includes(op.kind)) {
      const ids = changed.get(collection) ?? new Set<string>(); ids.add(op.targetId); changed.set(collection, ids);
    }
  }
  for (const [collection, rows] of Array.from(beforeIndexes)) {
    const actualRows = afterIndexes.get(collection);
    requireGuard(actualRows, "readback_collection_missing");
    if (collection !== "activityEvents") for (const id of Array.from(actualRows.keys())) requireGuard(rows.has(id) || created.get(collection)?.has(id), "unexpected_record_created");
    for (const [id, row] of Array.from(rows)) if (!changed.get(collection)?.has(id)) {
      const actual = actualRows.get(id);
      requireGuard(actual && hash(actual) === hash(row), "unrelated_record_changed");
    }
  }
  requireGuard(hash(before.ledgerTransactions) === hash(after.ledgerTransactions) && hash(before.paymentAllocations) === hash(after.paymentAllocations), "ledger_changed");
}
