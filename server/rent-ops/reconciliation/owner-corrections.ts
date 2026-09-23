/**
 * Owner-attested correction package -> guarded, reviewable correction plan.
 *
 * A research package (proposed-corrections.json plus supporting files) is
 * PREPARED_NOT_APPLIED research. This module never applies it. It re-reads the
 * current records, converts only the narrow supported correction kinds into
 * guarded operations, and holds everything else with an exact reason:
 *  - operational corrections become a MaintenancePack consumed unchanged by
 *    scripts/rent-ops-maintenance.ts (plan/apply with --apply-reviewed);
 *  - owner-instructed charge reversals become a separate ledger plan executed
 *    only through RentOpsService.reverseLedgerTransaction with exact charge
 *    revisions, before-hashes and an approved dry-run token;
 *  - nothing produces a payment, receipt, credit or deletion.
 * Private package contents stay outside the repository; callers write outputs
 * to a private directory only.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { RentOpsLedgerTransaction, RentOpsRepository, RentOpsSnapshot, RentOpsTenancy } from "../../../shared/rent-ops-contracts";
import { centsToBigInt, legacyNumberToCents, sumCents } from "../../../shared/company/money";
import { deriveDelinquency } from "../domain/reports";
import { balanceReviewLedgerFingerprint } from "../domain/balance-review";
import { nowIsoDate } from "../domain/dates";
import { RentOpsService } from "../services/service";
import { reconciliationHash, type ReconciliationEvidence } from "./operator";
import type { MaintenancePack, MaintenancePhase } from "./maintenance";

export const OWNER_CORRECTION_PACKAGE_FILES = [
  "proposed-corrections.json", "owner-instructions.json", "remaining-evidence.json", "live-account-inventory.json",
  "live-payment-observations.json", "checkpoint.json", "package-manifest.json",
] as const;

export type SupportedCorrectionKind = "tenancy-cancelled" | "owner-zero-balance-review" | "owner-charge-reversal" | "future-tenancy-unit-link";
export type HeldReason =
  | "payment-matching-required" | "housing-assistance-open" | "deposit-allocation-open" | "identity-mapping-open"
  | "history-reconciliation-open" | "remaining-evidence-listed" | "changed-since-research" | "charge-reversal-not-instructed"
  | "structured-resolution-missing" | "unsupported-research-status" | "account-not-found" | "ambiguous-tenancy"
  | "charge-not-reversible" | "unknown-amount" | "unit-link-unresolved" | "package-case-applied";

export interface PackageFileEvidence { name: string; path: string; sha256: string; manifestSha256?: string }
export interface OwnerCorrectionCase {
  index: number; tenant: string; researchStatus: string; applicationStatus: string; personId: string;
  before: Record<string, string>; confirmedFacts: string[]; proposedActions: string[]; unresolved: string[]; evidence: string[];
}
export interface LoadedCorrectionPackage {
  directory: string; asOf: string; status: string; controls: string[];
  files: Record<string, PackageFileEvidence>; cases: OwnerCorrectionCase[];
  ownerInstructions: Array<{ tenant?: string; ownerInstruction?: string; observedBefore?: { operational_balance_cents?: number; posted_ledger_total_cents?: number } }>;
  remainingEvidence: Array<{ case: string; missing: string }>;
}
/** Operator-authored structured facts where the package only states them in prose. */
export interface OwnerCorrectionResolutions {
  version: 1;
  cases: Array<{ personId: string; futureUnitLink?: { unitNumber: string; plannedMoveInOn: string; evidenceReference: string } }>;
}
export interface LoadedResolutions { path: string; sha256: string; value: OwnerCorrectionResolutions }

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const isoDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export class OwnerCorrectionPackageError extends Error { constructor(readonly code: string) { super(code); } }
function requirePackage(value: unknown, code: string): asserts value { if (!value) throw new OwnerCorrectionPackageError(code); }

export async function loadCorrectionPackage(directory: string): Promise<LoadedCorrectionPackage> {
  const root = resolve(directory);
  const files: Record<string, PackageFileEvidence> = {};
  const parsed: Record<string, unknown> = {};
  for (const name of OWNER_CORRECTION_PACKAGE_FILES) {
    let bytes: Buffer;
    try { bytes = await readFile(join(root, name)); } catch { continue; }
    files[name] = { name, path: join(root, name), sha256: sha256(bytes) };
    try { parsed[name] = JSON.parse(bytes.toString("utf8")); } catch { throw new OwnerCorrectionPackageError(`package_file_unparseable:${name}`); }
  }
  const proposed = parsed["proposed-corrections.json"];
  requirePackage(plain(proposed), "proposed_corrections_required");
  // The package must declare itself research-only and require a fresh read.
  requirePackage(proposed.automatic_execution_allowed === false && proposed.fresh_read_required_before_application === true, "package_controls_missing");
  requirePackage(isoDate(proposed.as_of) && Array.isArray(proposed.cases) && proposed.cases.length > 0, "invalid_package");
  const manifest = parsed["package-manifest.json"];
  if (plain(manifest) && Array.isArray(manifest.files)) {
    for (const entry of manifest.files) {
      if (!plain(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string") continue;
      const local = files[basename(entry.path)];
      if (!local || basename(entry.path) === "package-manifest.json") continue;
      requirePackage(local.sha256 === entry.sha256, `package_file_hash_mismatch:${local.name}`);
      local.manifestSha256 = entry.sha256;
    }
  }
  const cases = proposed.cases.map((row: unknown, index: number): OwnerCorrectionCase => {
    requirePackage(plain(row) && typeof row.person_id === "string" && row.person_id.trim() && typeof row.research_status === "string" && plain(row.before), `invalid_case:${index}`);
    return { index, tenant: String(row.tenant ?? ""), researchStatus: row.research_status, applicationStatus: String(row.application_status ?? ""), personId: row.person_id,
      before: Object.fromEntries(Object.entries(row.before).map(([key, value]) => [key, String(value)])), confirmedFacts: strings(row.confirmed_facts),
      proposedActions: strings(row.proposed_actions), unresolved: strings(row.unresolved), evidence: strings(row.evidence) };
  });
  const owner = parsed["owner-instructions.json"];
  const remaining = parsed["remaining-evidence.json"];
  return {
    directory: root, asOf: proposed.as_of, status: String(proposed.status ?? ""), controls: strings(proposed.controls), files, cases,
    ownerInstructions: plain(owner) && Array.isArray(owner.facts) ? owner.facts.filter(plain).map((row: any) => ({ tenant: typeof row.tenant === "string" ? row.tenant : undefined,
      ownerInstruction: typeof row.owner_instruction === "string" ? row.owner_instruction : undefined, observedBefore: plain(row.observed_before) ? row.observed_before : undefined })) : [],
    remainingEvidence: plain(remaining) && Array.isArray(remaining.items) ? remaining.items.filter(plain).map((row: any) => ({ case: String(row.case ?? ""), missing: String(row.missing ?? "") })) : [],
  };
}

export async function loadResolutions(path: string): Promise<LoadedResolutions> {
  const bytes = await readFile(resolve(path));
  const value = JSON.parse(bytes.toString("utf8"));
  requirePackage(plain(value) && value.version === 1 && Array.isArray(value.cases), "invalid_resolutions");
  for (const row of value.cases) {
    requirePackage(plain(row) && typeof row.personId === "string" && row.personId.trim(), "invalid_resolution_case");
    if (row.futureUnitLink !== undefined) requirePackage(plain(row.futureUnitLink) && typeof row.futureUnitLink.unitNumber === "string" && row.futureUnitLink.unitNumber.trim()
      && isoDate(row.futureUnitLink.plannedMoveInOn) && typeof row.futureUnitLink.evidenceReference === "string" && row.futureUnitLink.evidenceReference.trim(), "invalid_future_unit_link_resolution");
  }
  return { path: resolve(path), sha256: sha256(bytes), value: value as unknown as OwnerCorrectionResolutions };
}

// ---------------------------------------------------------------------------
// Classification (package only)

export interface ActionDisposition { actionIndex: number; action: string; coveredBy?: SupportedCorrectionKind; held?: HeldReason }
export interface CaseClassification {
  supported: SupportedCorrectionKind[];
  actions: ActionDisposition[];
  caseHeld: Array<{ reason: HeldReason; detail: string }>;
}

const OPEN_STATUS_REASONS: Record<string, HeldReason[]> = {
  CONTRACT_RESOLVED_PAYMENT_ALLOCATION_OPEN: ["payment-matching-required", "housing-assistance-open"],
  RECEIPTS_EXIST_ALLOCATION_OPEN: ["payment-matching-required", "housing-assistance-open"],
  RECEIPT_EXISTS_DATE_AND_ALLOCATION_OPEN: ["payment-matching-required", "housing-assistance-open"],
  LEASE_AND_CASH_ALLOCATION_OPEN: ["payment-matching-required"],
  CASHAPP_PARTLY_RESOLVED_SEPTEMBER_OPEN: ["payment-matching-required"],
  BASE_RENT_RESOLVED_HISTORY_OPEN: ["history-reconciliation-open"],
  CHARGE_CATEGORY_RESOLVED_NET_ALLOCATION_OPEN: ["deposit-allocation-open"],
  IDENTITY_MAPPING_OPEN: ["identity-mapping-open"],
};
const SUPPORTED_STATUS: Record<string, SupportedCorrectionKind[]> = {
  OCCUPANCY_RESOLVED_OWNER_ATTESTED: ["tenancy-cancelled"],
  ZERO_BALANCE_RESOLVED_OWNER_ATTESTED: ["owner-zero-balance-review"],
  ZERO_CHARGE_CORRECTION_RESOLVED_OWNER_INSTRUCTED: ["owner-charge-reversal", "tenancy-cancelled"],
  UNIT_AND_FUTURE_TERM_RESOLVED: ["future-tenancy-unit-link"],
};

function actionReason(text: string): HeldReason {
  if (/deposit/i.test(text)) return "deposit-allocation-open";
  if (/\bHAP\b|subsid|assistance|agency|remittance|housing/i.test(text)) return "housing-assistance-open";
  if (/receipt|payment|zelle|cash ?app|check|cash|allocat/i.test(text)) return "payment-matching-required";
  if (/identity|source established|quarantine/i.test(text)) return "identity-mapping-open";
  return "history-reconciliation-open";
}
const nameTokens = (text: string) => text.toLowerCase().split(/[^a-z]+/).filter(token => token.length >= 3);

/** Remaining-evidence items name cases loosely (often by first name). Any shared name token
 * holds the case: a false match only holds more, it never converts anything. */
export function matchRemainingEvidence(pkg: LoadedCorrectionPackage, item: OwnerCorrectionCase) {
  const tokens = nameTokens(item.tenant);
  if (!tokens.length) return [];
  return pkg.remainingEvidence.filter(row => { const words = nameTokens(row.case); return tokens.some(token => words.includes(token)); });
}

export function classifyCase(pkg: LoadedCorrectionPackage, item: OwnerCorrectionCase): CaseClassification {
  const caseHeld: CaseClassification["caseHeld"] = [];
  if (item.applicationStatus !== "NOT_APPLIED") caseHeld.push({ reason: "package-case-applied", detail: "Package case is not marked NOT_APPLIED; re-research before any change" });
  for (const row of matchRemainingEvidence(pkg, item)) caseHeld.push({ reason: "remaining-evidence-listed", detail: row.missing });
  const supportedKinds = SUPPORTED_STATUS[item.researchStatus];
  if (!supportedKinds) {
    const reasons = OPEN_STATUS_REASONS[item.researchStatus] ?? ["unsupported-research-status" as HeldReason];
    for (const reason of reasons) caseHeld.push({ reason, detail: `Research status ${item.researchStatus}` });
    return { supported: [], caseHeld, actions: item.proposedActions.map((action, actionIndex) => ({ actionIndex, action, held: actionReason(action) })) };
  }
  const actions: ActionDisposition[] = item.proposedActions.map((action, actionIndex) => {
    if (item.researchStatus === "ZERO_BALANCE_RESOLVED_OWNER_ATTESTED" && /correction|reversal/i.test(action)) return { actionIndex, action, held: "charge-reversal-not-instructed" };
    if (item.researchStatus === "UNIT_AND_FUTURE_TERM_RESOLVED" && /deposit|receipt|cash|payment/i.test(action)) return { actionIndex, action, held: actionReason(action) };
    const coveredBy = item.researchStatus === "ZERO_CHARGE_CORRECTION_RESOLVED_OWNER_INSTRUCTED" && /revers|charge/i.test(action) ? "owner-charge-reversal"
      : item.researchStatus === "ZERO_CHARGE_CORRECTION_RESOLVED_OWNER_INSTRUCTED" ? "tenancy-cancelled" : supportedKinds[0];
    return { actionIndex, action, coveredBy };
  });
  // Any case-level hold (remaining evidence, applied state) blocks conversion entirely.
  return { supported: caseHeld.length ? [] : supportedKinds, caseHeld, actions };
}

const FRESH_READBACKS: Record<SupportedCorrectionKind, string[]> = {
  "tenancy-cancelled": ["Person exists by exact package person ID", "Account row (property, unit, tenant, tenant status, operational balance, posted ledger total) equals the package before-state",
    "Exactly one imported non-cancelled tenancy for the person in the researched property/unit; current revision and before-hash"],
  "owner-zero-balance-review": ["Person exists by exact package person ID", "Account row equals the package before-state", "Exactly one tenancy for the person in the property with an exact unit link; current revision and before-hash",
    "Account ledger fingerprint at build time (a later ledger change makes the review stale)"],
  "owner-charge-reversal": ["Person exists by exact package person ID", "Account row equals the package before-state",
    "Exact current charge IDs, amounts, posted dates, categories, allocation state, charge-edit revision and before-hash", "Sum of open charges equals the researched posted ledger total",
    "No payments, credits, adjustments or allocations on the account (otherwise payment matching is required)"],
  "future-tenancy-unit-link": ["Person exists by exact package person ID", "Account row equals the package before-state", "Exactly one imported future tenancy for the person; no occupancy facts",
    "Destination unit guard (revision and before-hash) and no conflicting future/current tenancy in that unit", "Structured unit number and signed-lease start date supplied in the resolutions file"],
};

export interface ChecklistCase {
  index: number; personId: string; tenant: string; researchStatus: string; researchBefore: Record<string, string>;
  disposition: "supported" | "partially-supported" | "held";
  supportedActions: Array<{ kind: SupportedCorrectionKind; requiredFreshReadbacks: string[]; requiresStructuredResolution?: string[]; evidence: ReconciliationEvidence[] }>;
  held: Array<{ reason: HeldReason; action?: string; detail: string }>;
  qualifications: string[];
}
export interface OwnerCorrectionChecklist {
  kind: "owner-correction-checklist"; generatedAt: string; applicationStatus: "NOT_APPLIED"; packageAsOf: string; packageStatus: string;
  package: Array<{ name: string; sha256: string; matchesPackageManifest: boolean | null }>;
  controls: string[];
  counts: { cases: number; supported: number; partiallySupported: number; held: number; supportedActionsByKind: Record<string, number>; heldItemsByReason: Record<string, number>; packageLevelHeld: number };
  cases: ChecklistCase[];
  packageLevelHeld: Array<{ reason: HeldReason; case: string; detail: string }>;
  /** Fill from the signed documents, save privately and pass with --resolutions; blanks fail validation. */
  resolutionsTemplate: { version: 1; cases: Array<{ personId: string; futureUnitLink: { unitNumber: string; plannedMoveInOn: string; evidenceReference: string } }> };
}

function caseEvidence(pkg: LoadedCorrectionPackage, item: OwnerCorrectionCase): ReconciliationEvidence[] {
  const proposed = pkg.files["proposed-corrections.json"];
  const evidence: ReconciliationEvidence[] = [{ path: proposed.path, sha256: proposed.sha256, reference: `proposed-corrections.json#/cases/${item.index} ${item.researchStatus}` }];
  for (const name of item.evidence) {
    const file = pkg.files[name];
    if (file && file.name !== proposed.name) evidence.push({ path: file.path, sha256: file.sha256, reference: `${file.name} (cited by case ${item.index})` });
  }
  return evidence;
}

function tally(values: string[]) { const out: Record<string, number> = {}; for (const value of values) out[value] = (out[value] ?? 0) + 1; return Object.fromEntries(Object.entries(out).sort()); }

/** Package-only resolution checklist: no records are read or changed. */
export function buildResolutionChecklist(pkg: LoadedCorrectionPackage, generatedAt: string): OwnerCorrectionChecklist {
  const cases = pkg.cases.map((item): ChecklistCase => {
    const classification = classifyCase(pkg, item);
    const held: ChecklistCase["held"] = [...classification.caseHeld];
    for (const action of classification.actions) if (action.held) held.push({ reason: action.held, action: action.action, detail: `Proposed action ${action.actionIndex} is not converted into an operation` });
    const supportedActions = classification.supported.map(kind => ({ kind, requiredFreshReadbacks: FRESH_READBACKS[kind], evidence: caseEvidence(pkg, item),
      ...(kind === "future-tenancy-unit-link" ? { requiresStructuredResolution: ["futureUnitLink.unitNumber", "futureUnitLink.plannedMoveInOn", "futureUnitLink.evidenceReference"] } : {}) }));
    const disposition = !supportedActions.length ? "held" : held.length ? "partially-supported" : "supported";
    return { index: item.index, personId: item.personId, tenant: item.tenant, researchStatus: item.researchStatus, researchBefore: item.before, disposition, supportedActions, held, qualifications: item.unresolved };
  });
  const matched = new Set(pkg.cases.flatMap(item => matchRemainingEvidence(pkg, item)));
  const packageLevelHeld = pkg.remainingEvidence.filter(row => !matched.has(row)).map(row => ({ reason: "remaining-evidence-listed" as HeldReason, case: row.case, detail: row.missing }));
  return {
    kind: "owner-correction-checklist", generatedAt, applicationStatus: "NOT_APPLIED", packageAsOf: pkg.asOf, packageStatus: pkg.status,
    package: Object.values(pkg.files).map(file => ({ name: file.name, sha256: file.sha256, matchesPackageManifest: file.manifestSha256 ? file.manifestSha256 === file.sha256 : null })),
    controls: pkg.controls,
    counts: { cases: cases.length, supported: cases.filter(row => row.disposition === "supported").length, partiallySupported: cases.filter(row => row.disposition === "partially-supported").length,
      held: cases.filter(row => row.disposition === "held").length, supportedActionsByKind: tally(cases.flatMap(row => row.supportedActions.map(action => action.kind))),
      heldItemsByReason: tally([...cases.flatMap(row => row.held.map(item => item.reason)), ...packageLevelHeld.map(row => row.reason)]), packageLevelHeld: packageLevelHeld.length },
    cases, packageLevelHeld,
    resolutionsTemplate: { version: 1, cases: cases.filter(row => row.supportedActions.some(action => action.kind === "future-tenancy-unit-link"))
      .map(row => ({ personId: row.personId, futureUnitLink: { unitNumber: "", plannedMoveInOn: "", evidenceReference: "" } })) },
  };
}

// ---------------------------------------------------------------------------
// Fresh readback against a snapshot

/** "$1,234.56" -> "123456"; "Needs review" -> null (unknown, never zero). */
export function parseDisplayedCents(text: string): { known: true; cents: string | null } | { known: false } {
  const value = text.trim().replace(/^'/, "");
  if (/^needs review$/i.test(value)) return { known: true, cents: null };
  const match = /^(-)?\$?(-)?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})$/.exec(value);
  if (!match || (match[1] && match[2])) return { known: false };
  const digits = BigInt(match[3].replaceAll(",", "") + match[4]);
  return { known: true, cents: ((match[1] || match[2]) && digits !== BigInt(0) ? -digits : digits).toString() };
}
const normalizeLabel = (value: string | undefined) => (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const STATUS_LABEL: Record<string, string> = { current: "current", former: "former", future: "future", unknown: "unknown" };

export interface AccountReadback { ok: boolean; mismatchedFields: string[]; row?: ReturnType<typeof deriveDelinquency>[number] }
export function readAccountBackAgainstResearch(snapshot: RentOpsSnapshot, item: OwnerCorrectionCase, asOfDate: string): AccountReadback {
  const rows = deriveDelinquency(snapshot, { tenantStatus: "all", asOfDate }).filter(row => row.personId === item.personId);
  const property = item.before["Property"];
  const candidates = property ? rows.filter(row => normalizeLabel(row.propertyName) === normalizeLabel(property)) : rows;
  if (candidates.length !== 1) return { ok: false, mismatchedFields: ["account-row"] };
  const row = candidates[0];
  const mismatched: string[] = [];
  const unit = item.before["Unit"];
  if (unit !== undefined && (/^needs review$/i.test(unit.trim()) ? row.unitNumber !== undefined : normalizeLabel(row.unitNumber) !== normalizeLabel(unit))) mismatched.push("Unit");
  const tenant = item.before["Tenant"];
  if (tenant !== undefined && normalizeLabel(row.tenantName) !== normalizeLabel(tenant)) mismatched.push("Tenant");
  const status = item.before["Tenant status"];
  if (status !== undefined && STATUS_LABEL[row.tenancyStatus ?? "unknown"] !== status.trim().toLowerCase()) mismatched.push("Tenant status");
  for (const [field, live] of [["Operational balance", row.operationalBalanceCents], ["Posted ledger total", row.totalBalanceCents]] as const) {
    const text = item.before[field];
    if (text === undefined) continue;
    const parsed = parseDisplayedCents(text);
    const liveCents = live === null || live === undefined ? null : legacyNumberToCents(live);
    if (!parsed.known || parsed.cents !== liveCents) mismatched.push(field);
  }
  return { ok: mismatched.length === 0, mismatchedFields: mismatched, row };
}

// ---------------------------------------------------------------------------
// Ledger reversal plan

export interface OwnerChargeReversalEntry {
  chargeId: string; amountCents: string; postedOn: string; category: string; expectedRevision: string; beforeSha256: string;
  reversalId: string; reversalPostedOn: string;
}
export interface OwnerChargeReversalAccount {
  caseIndex: number; personId: string; propertyId: string; accountLedgerSha256: string; expectedPostedTotalCents: string;
  entries: OwnerChargeReversalEntry[]; evidence: ReconciliationEvidence[];
}
export interface OwnerChargeReversalPlan {
  version: 1; kind: "owner-charge-reversal-plan"; id: string; generatedAt: string; packageSha256: string;
  guarantees: { createsPayments: false; createsReceipts: false; deletesOriginals: false; route: "RentOpsService.reverseLedgerTransaction" };
  accounts: OwnerChargeReversalAccount[];
}

/** Same revision the audited charge editor issues (RentOpsService.chargeEditContext). */
export function chargeEditRevision(snapshot: RentOpsSnapshot, chargeId: string): string {
  const charge = snapshot.ledgerTransactions.find(row => row.id === chargeId);
  const history = snapshot.paymentAllocations.filter(row => row.chargeTransactionId === chargeId);
  const payments = snapshot.ledgerTransactions.filter(row => history.some(allocation => allocation.paymentTransactionId === row.id) || row.kind === "reversal" && history.some(allocation => allocation.paymentTransactionId === row.reversalOfId)).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify({ charge, allocations: [...history].sort((a, b) => a.id.localeCompare(b.id)), payments })).digest("hex");
}
const exactLink = (value: string | null | undefined) => value === "exact" || value === "manual";

function planChargeReversals(snapshot: RentOpsSnapshot, item: OwnerCorrectionCase, propertyId: string, expectedTotal: string, today: string, planSeed: string):
  { ok: true; entries: OwnerChargeReversalEntry[] } | { ok: false; reason: HeldReason; detail: string } {
  const tenancyIds = new Set(snapshot.tenancies.filter(row => row.primaryPersonId === item.personId).map(row => row.id));
  const account = snapshot.ledgerTransactions.filter(row => row.personId === item.personId || tenancyIds.has(row.tenancyId ?? ""));
  if (account.some(row => row.propertyId !== propertyId)) return { ok: false, reason: "charge-not-reversible", detail: "Account ledger spans another or unknown property" };
  const reversed = new Set(account.filter(row => row.kind === "reversal" && row.status === "posted").map(row => row.reversalOfId));
  const live = account.filter(row => row.kind !== "reversal" && row.status !== "voided" && !reversed.has(row.id));
  if (live.some(row => row.status !== "posted")) return { ok: false, reason: "charge-not-reversible", detail: "Account has pending or unresolved-status entries" };
  if (live.some(row => row.kind !== "charge")) return { ok: false, reason: "payment-matching-required", detail: "Account has payments, credits or adjustments; charge reversal alone would create or move cash" };
  const ids = new Set(live.map(row => row.id));
  if (snapshot.paymentAllocations.some(row => ids.has(row.chargeTransactionId ?? "") || ids.has(row.paymentTransactionId ?? "") || ids.has(row.creditTransactionId ?? ""))) return { ok: false, reason: "payment-matching-required", detail: "Charges carry allocations" };
  if (!live.length) return { ok: false, reason: "changed-since-research", detail: "No open charges to reverse" };
  for (const charge of live) {
    if (typeof charge.amountCents !== "number" || !Number.isSafeInteger(charge.amountCents) || charge.amountCents <= 0) return { ok: false, reason: "unknown-amount", detail: `Charge ${charge.id} amount is unknown` };
    if (!isoDate(charge.postedOn) || !charge.category || !charge.description || !charge.propertyId || !charge.personId) return { ok: false, reason: "charge-not-reversible", detail: `Charge ${charge.id} has unresolved financial facts` };
    if (charge.postedOn > today) return { ok: false, reason: "charge-not-reversible", detail: `Charge ${charge.id} is future-dated` };
    if ([charge.propertyLinkKnowledge, charge.personLinkKnowledge, ...(charge.unitId ? [charge.unitLinkKnowledge] : []), ...(charge.tenancyId ? [charge.tenancyLinkKnowledge] : [])].some(value => !exactLink(value))) return { ok: false, reason: "charge-not-reversible", detail: `Charge ${charge.id} account links need review` };
  }
  const total = sumCents(live.map(row => legacyNumberToCents(row.amountCents!)));
  if (total !== expectedTotal) return { ok: false, reason: "changed-since-research", detail: "Open charges no longer equal the researched posted total" };
  const entries = [...live].sort((a, b) => a.postedOn!.localeCompare(b.postedOn!) || a.id.localeCompare(b.id)).map(charge => ({
    chargeId: charge.id, amountCents: legacyNumberToCents(charge.amountCents!), postedOn: charge.postedOn!, category: charge.category!, expectedRevision: chargeEditRevision(snapshot, charge.id),
    beforeSha256: reconciliationHash(charge), reversalId: `owner-correction-reversal:${sha256(`${planSeed}\u0000${charge.id}`).slice(0, 40)}`, reversalPostedOn: today,
  }));
  return { ok: true, entries };
}

// ---------------------------------------------------------------------------
// Builder

export interface OwnerCorrectionHeldItem { caseIndex: number | null; personId?: string; kind?: SupportedCorrectionKind; action?: string; reason: HeldReason; detail: string }
export interface OwnerCorrectionBuild {
  pack: MaintenancePack | null;
  ledgerPlan: OwnerChargeReversalPlan | null;
  held: OwnerCorrectionHeldItem[];
  summary: { cases: number; operations: number; operationsByKind: Record<string, number>; chargeReversals: number; heldByReason: Record<string, number> };
}
export interface BuildOptions { occurredAt: string; baselineSha256: string; resolutions?: LoadedResolutions }

interface PackOp { target: { collection: "tenancies"; id: string }; expected: Record<string, unknown>; values: Record<string, unknown>; reference: string; packageEvidence: ReconciliationEvidence[] }

export function buildOwnerCorrectionPlan(pkg: LoadedCorrectionPackage, snapshot: RentOpsSnapshot, options: BuildOptions): OwnerCorrectionBuild {
  if (!Number.isFinite(Date.parse(options.occurredAt)) || !/^[a-f0-9]{64}$/.test(options.baselineSha256)) throw new OwnerCorrectionPackageError("explicit_time_and_baseline_required");
  const today = nowIsoDate(new Date(options.occurredAt));
  const proposed = pkg.files["proposed-corrections.json"];
  const held: OwnerCorrectionHeldItem[] = [];
  const ops: PackOp[] = [];
  const accounts: OwnerChargeReversalAccount[] = [];
  const planSeed = sha256(`${proposed.sha256}\u0000${options.baselineSha256}`);
  const holdAll = (item: OwnerCorrectionCase, kinds: SupportedCorrectionKind[], reason: HeldReason, detail: string) => { for (const kind of kinds) held.push({ caseIndex: item.index, personId: item.personId, kind, reason, detail }); };
  for (const item of pkg.cases) {
    const classification = classifyCase(pkg, item);
    for (const row of classification.caseHeld) held.push({ caseIndex: item.index, personId: item.personId, reason: row.reason, detail: row.detail });
    for (const action of classification.actions) if (action.held) held.push({ caseIndex: item.index, personId: item.personId, action: action.action, reason: action.held, detail: `Proposed action ${action.actionIndex} is not converted into an operation` });
    const kinds = classification.supported;
    if (!kinds.length) continue;
    const person = snapshot.people.find(row => row.id === item.personId);
    if (!person) { holdAll(item, kinds, "account-not-found", "Package person ID is not present in the current records"); continue; }
    const readback = readAccountBackAgainstResearch(snapshot, item, today);
    if (!readback.ok || !readback.row?.propertyId) { holdAll(item, kinds, "changed-since-research", `Fresh readback differs from package before-state: ${readback.mismatchedFields.join(", ") || "account-row"}`); continue; }
    const propertyId = readback.row.propertyId;
    const personTenancies = snapshot.tenancies.filter(row => row.primaryPersonId === item.personId && row.propertyId === propertyId);
    const evidence = caseEvidence(pkg, item);
    const reference = `${evidence[0].reference} sha256:${proposed.sha256}`;
    const guardFields = (tenancy: RentOpsTenancy) => ({ status: tenancy.status, primaryPersonId: tenancy.primaryPersonId, propertyId: tenancy.propertyId, unitId: tenancy.unitId });
    for (const kind of kinds) {
      if (kind === "tenancy-cancelled") {
        const candidates = personTenancies.filter(row => row.status !== "cancelled");
        const unitLabel = item.before["Unit"];
        const scoped = unitLabel && !/^needs review$/i.test(unitLabel.trim()) ? candidates.filter(row => normalizeLabel(snapshot.units.find(unit => unit.id === row.unitId)?.unitNumber) === normalizeLabel(unitLabel)) : candidates;
        if (scoped.length !== 1 || scoped[0].source?.system !== "rent_manager") { holdAll(item, [kind], "ambiguous-tenancy", `Expected exactly one imported non-cancelled tenancy; found ${scoped.length}`); continue; }
        const tenancy = scoped[0];
        ops.push({ target: { collection: "tenancies", id: tenancy.id }, expected: guardFields(tenancy), values: { kind: "tenancy-status", status: "cancelled" }, reference, packageEvidence: evidence });
      } else if (kind === "owner-zero-balance-review") {
        if (personTenancies.length !== 1) { holdAll(item, [kind], "ambiguous-tenancy", `Expected exactly one tenancy in the property; found ${personTenancies.length}`); continue; }
        const tenancy = personTenancies[0];
        if (!exactLink(tenancy.unitLinkKnowledge) && !(snapshot.modelVersion !== 3 && tenancy.unitLinkKnowledge === undefined)) { holdAll(item, [kind], "unit-link-unresolved", "Tenancy unit link is unresolved; a review would not attach to the account"); continue; }
        if (tenancy.source?.system !== "rent_manager" && tenancy.statusKnowledge !== "manual") { holdAll(item, [kind], "ambiguous-tenancy", "Target tenancy is neither imported nor a canonical manual tenancy"); continue; }
        const sourceRefs = evidence.map(row => `${row.reference} sha256:${row.sha256}`);
        ops.push({ target: { collection: "tenancies", id: tenancy.id }, expected: guardFields(tenancy), reference, packageEvidence: evidence, values: { kind: "balance-review", review: {
          schema: "balance_review_v1", id: `balance-review:owner-correction:${sha256(`${planSeed}\u0000${tenancy.id}`).slice(0, 40)}`, tenancyId: tenancy.id, personId: tenancy.primaryPersonId,
          propertyId: tenancy.propertyId, unitId: tenancy.unitId, asOfDate: pkg.asOf, reviewedBalanceCents: 0, tenantBalanceCents: 0, agencyBalanceCents: null,
          qualifications: ["Owner-attested zero operational balance; no receipt, payment or waiver recorded", "Agency balance not stated (unknown, not zero)", ...item.unresolved], sourceRefs } } });
      } else if (kind === "owner-charge-reversal") {
        const totalText = item.before["Posted ledger total"];
        const parsed = totalText === undefined ? { known: false as const } : parseDisplayedCents(totalText);
        if (!parsed.known || parsed.cents === null || centsToBigInt(parsed.cents) <= BigInt(0)) { holdAll(item, [kind], "unknown-amount", "Researched posted total is unknown; reversal amount cannot be established"); continue; }
        const instruction = pkg.ownerInstructions.find(row => row.tenant && normalizeLabel(row.tenant) === normalizeLabel(item.tenant));
        const observed = instruction?.observedBefore?.posted_ledger_total_cents;
        if (!instruction?.ownerInstruction || (observed !== undefined && (!Number.isSafeInteger(observed) || legacyNumberToCents(observed) !== parsed.cents))) { holdAll(item, [kind], "charge-reversal-not-instructed", "Owner instruction to zero charges is absent or disagrees with the researched total"); continue; }
        const result = planChargeReversals(snapshot, item, propertyId, parsed.cents, today, planSeed);
        if (!result.ok) { holdAll(item, [kind], result.reason, result.detail); continue; }
        const ownerFile = pkg.files["owner-instructions.json"];
        accounts.push({ caseIndex: item.index, personId: item.personId, propertyId, accountLedgerSha256: balanceReviewLedgerFingerprint(snapshot, item.personId), expectedPostedTotalCents: parsed.cents,
          entries: result.entries, evidence: [...evidence, ...(ownerFile && !evidence.some(row => row.path === ownerFile.path) ? [{ path: ownerFile.path, sha256: ownerFile.sha256, reference: "owner-instructions.json owner_instruction" }] : [])] });
      } else if (kind === "future-tenancy-unit-link") {
        const resolution = options.resolutions?.value.cases.find(row => row.personId === item.personId)?.futureUnitLink;
        if (!resolution) { holdAll(item, [kind], "structured-resolution-missing", "Supply futureUnitLink {unitNumber, plannedMoveInOn, evidenceReference} from the signed lease in the resolutions file"); continue; }
        const future = personTenancies.filter(row => row.status === "future");
        if (future.length !== 1 || future[0].source?.system !== "rent_manager") { holdAll(item, [kind], "ambiguous-tenancy", `Expected exactly one imported future tenancy; found ${future.length}`); continue; }
        const units = snapshot.units.filter(unit => unit.propertyId === propertyId && normalizeLabel(unit.unitNumber) === normalizeLabel(resolution.unitNumber));
        if (units.length !== 1) { holdAll(item, [kind], "ambiguous-tenancy", `Resolution unit matches ${units.length} units in the property`); continue; }
        if (resolution.plannedMoveInOn <= today) { holdAll(item, [kind], "changed-since-research", "Signed term start is no longer in the future; occupancy needs separate confirmation"); continue; }
        const tenancy = future[0];
        const resolutionEvidence = options.resolutions ? [{ path: options.resolutions.path, sha256: options.resolutions.sha256, reference: resolution.evidenceReference }] : [];
        ops.push({ target: { collection: "tenancies", id: tenancy.id }, expected: guardFields(tenancy), reference: `${reference}; resolution ${resolution.evidenceReference}`, packageEvidence: [...evidence, ...resolutionEvidence],
          values: { kind: "future-tenancy-unit-link", plannedMoveInOn: resolution.plannedMoveInOn, unitGuard: { $guard: { collection: "units", id: units[0].id } } } });
      }
    }
  }
  // Each original target occurs once per guarded phase.
  const phases: MaintenancePhase[] = [];
  for (const op of ops) {
    let phase = phases.find(candidate => !candidate.operations.some(existing => existing.target.id === op.target.id));
    if (!phase) { phase = { id: `owner-corrections-${phases.length + 1}`, operations: [] }; phases.push(phase); }
    phase.operations.push(op as MaintenancePhase["operations"][number]);
  }
  const packageFiles = Object.values(pkg.files).map(file => ({ name: file.name, path: file.path, sha256: file.sha256 }));
  const pack: MaintenancePack | null = phases.length ? {
    version: 1, initialBaselineSha256: options.baselineSha256,
    counts: { people: snapshot.people.length, tenancies: snapshot.tenancies.length, units: snapshot.units.length, ledgerTransactions: snapshot.ledgerTransactions.length, paymentAllocations: snapshot.paymentAllocations.length },
    phases, provenance: { tool: "build-owner-correction-plan", applicationStatus: "PREPARED_NOT_APPLIED", packageAsOf: pkg.asOf, packageFiles, resolutions: options.resolutions ? { path: options.resolutions.path, sha256: options.resolutions.sha256 } : null, builtAt: options.occurredAt },
  } : null;
  const ledgerPlan: OwnerChargeReversalPlan | null = accounts.length ? {
    version: 1, kind: "owner-charge-reversal-plan", id: `owner-charge-reversal:${planSeed.slice(0, 24)}`, generatedAt: options.occurredAt, packageSha256: proposed.sha256,
    guarantees: { createsPayments: false, createsReceipts: false, deletesOriginals: false, route: "RentOpsService.reverseLedgerTransaction" }, accounts,
  } : null;
  return { pack, ledgerPlan, held, summary: { cases: pkg.cases.length, operations: ops.length, operationsByKind: tally(ops.map(op => String(op.values.kind))),
    chargeReversals: accounts.reduce((sum, account) => sum + account.entries.length, 0), heldByReason: tally(held.map(row => row.reason)) } };
}

/** Verify each pack operation's package evidence still hashes to the recorded bytes. */
export async function verifyPackageEvidence(evidence: ReconciliationEvidence[]) {
  const seen = new Map<string, string>();
  for (const row of evidence) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || !row.reference?.trim()) throw new OwnerCorrectionPackageError("package_evidence_invalid");
    const actual = seen.get(row.path) ?? sha256(await readFile(row.path));
    seen.set(row.path, actual);
    if (actual !== row.sha256) throw new OwnerCorrectionPackageError("package_evidence_hash_mismatch");
  }
}

// ---------------------------------------------------------------------------
// Ledger reversal executor (plan = rolled-back dry run; apply = exact approved token)

export interface ChargeReversalResult { token: string; planSha256: string; changes: Array<{ chargeId: string; reversalId: string; amountCents: string; before: RentOpsLedgerTransaction; after: RentOpsLedgerTransaction }>; paymentsCreated: 0 }
class ReversalRollback extends Error { constructor(readonly result: ChargeReversalResult) { super("Owner charge reversal dry run rollback"); } }

export async function runOwnerChargeReversals(repository: RentOpsRepository, plan: OwnerChargeReversalPlan, options: { mode: "plan" | "apply"; approvedPlanToken?: string; actorSubject: string; occurredAt: string }): Promise<ChargeReversalResult> {
  if (options.mode !== "plan" && options.mode !== "apply") throw new Error("Explicit plan or apply mode required");
  if (!options.actorSubject?.trim() || !Number.isFinite(Date.parse(options.occurredAt))) throw new Error("Explicit actor and time required");
  if (plan?.version !== 1 || plan.kind !== "owner-charge-reversal-plan" || !plan.accounts?.length || plan.guarantees?.createsPayments !== false || plan.guarantees?.createsReceipts !== false || plan.guarantees?.deletesOriginals !== false) throw new Error("Invalid owner charge reversal plan");
  const allEntries = plan.accounts.flatMap(account => account.entries);
  if (!allEntries.length || new Set(allEntries.map(row => row.chargeId)).size !== allEntries.length || new Set(allEntries.map(row => row.reversalId)).size !== allEntries.length) throw new Error("Each charge and reversal identity must occur once");
  for (const account of plan.accounts) {
    if (!account.evidence?.length) throw new Error("Verified package evidence required");
    await verifyPackageEvidence(account.evidence);
    if (sumCents(account.entries.map(row => row.amountCents)) !== account.expectedPostedTotalCents) throw new Error("Reversal entries do not conserve the researched total");
  }
  const planSha256 = reconciliationHash(plan);
  const today = nowIsoDate(new Date(options.occurredAt));
  try {
    return await repository.transaction(async transaction => {
      const before = await transaction.getSnapshot();
      const charges = new Map(before.ledgerTransactions.map(row => [row.id, row]));
      const reversedIds = new Set(before.ledgerTransactions.filter(row => row.kind === "reversal" && row.status === "posted").map(row => row.reversalOfId));
      const service = new RentOpsService(transaction, () => new Date(options.occurredAt));
      for (const account of plan.accounts) {
        if (balanceReviewLedgerFingerprint(before, account.personId) !== account.accountLedgerSha256) throw new Error("Account ledger changed since the reversal plan was built");
        for (const entry of account.entries) {
          const charge = charges.get(entry.chargeId);
          if (!charge || charge.kind !== "charge" || charge.status !== "posted" || charge.personId !== account.personId || charge.propertyId !== account.propertyId
            || typeof charge.amountCents !== "number" || legacyNumberToCents(charge.amountCents) !== entry.amountCents || reconciliationHash(charge) !== entry.beforeSha256
            || reversedIds.has(entry.chargeId) || charges.has(entry.reversalId)
            || before.paymentAllocations.some(row => row.chargeTransactionId === entry.chargeId)
            || entry.reversalPostedOn !== today || !charge.postedOn || entry.reversalPostedOn < charge.postedOn) throw new Error(`Charge before-state changed: ${entry.chargeId}`);
          // The audited editor's own revision and link checks must accept the exact charge.
          const context = await service.chargeEditContext(entry.chargeId).catch(() => undefined);
          if (!context || context.expectedRevision !== entry.expectedRevision || context.allocations.length) throw new Error(`Charge revision changed: ${entry.chargeId}`);
        }
      }
      const token = reconciliationHash({ planSha256, accounts: plan.accounts.map(account => ({ personId: account.personId, fingerprint: account.accountLedgerSha256, charges: account.entries.map(entry => charges.get(entry.chargeId)) })) });
      if (options.mode === "apply" && options.approvedPlanToken !== token) throw new Error("Exact approved dry-run plan token required");
      const changes: ChargeReversalResult["changes"] = [];
      for (const entry of allEntries) {
        // The audited admin reversal path: posts a linked reversal, never deletes or rewrites the original.
        // The reversal is an operator entry, not imported evidence: like the audited charge-correction path it
        // carries manual provenance, no artifact binding and no due date of its own.
        const original = charges.get(entry.chargeId)!;
        const after = await service.reverseLedgerTransaction(entry.chargeId, { id: entry.reversalId, postedOn: entry.reversalPostedOn, description: "Owner-instructed charge reversal", status: "posted",
          dueOn: null, dueOnKnowledge: "unknown", sourceArtifactSha256: null, artifactObservationOn: null, statusKnowledge: "manual", amountKnowledge: "known", postedOnKnowledge: "manual",
          descriptionKnowledge: "manual", categoryKnowledge: original.category ? "manual" : "unknown", payer: original.payer, payerKnowledge: original.payer && original.payer !== "unknown" ? "manual" : "unknown",
          paymentMethod: null, paymentMethodKnowledge: "unknown", propertyLinkKnowledge: "manual", unitLinkKnowledge: original.unitId ? "manual" : "unknown", tenancyLinkKnowledge: original.tenancyId ? "manual" : "unknown",
          personLinkKnowledge: "manual", chargeDefinitionId: null, chargeDefinitionLinkKnowledge: "unknown", allocationMode: null });
        changes.push({ chargeId: entry.chargeId, reversalId: entry.reversalId, amountCents: entry.amountCents, before: charges.get(entry.chargeId)!, after });
      }
      const afterSnapshot = await transaction.getSnapshot();
      const expectedNew = new Set(allEntries.map(row => row.reversalId));
      const added = afterSnapshot.ledgerTransactions.filter(row => !charges.has(row.id));
      if (added.length !== expectedNew.size || added.some(row => !expectedNew.has(row.id) || row.kind !== "reversal")) throw new Error("Reversal produced an unexpected ledger entry");
      for (const entry of allEntries) {
        const reversal = afterSnapshot.ledgerTransactions.find(row => row.id === entry.reversalId)!;
        if (reversal.reversalOfId !== entry.chargeId || reversal.amountCents === null || legacyNumberToCents(reversal.amountCents) !== entry.amountCents || reversal.status !== "posted") throw new Error("Reversal readback differs");
      }
      for (const [id, row] of Array.from(charges)) {
        const current = afterSnapshot.ledgerTransactions.find(candidate => candidate.id === id);
        if (!current || reconciliationHash(current) !== reconciliationHash(row)) throw new Error("Original ledger entry changed or disappeared");
      }
      if (reconciliationHash(afterSnapshot.paymentAllocations) !== reconciliationHash(before.paymentAllocations)) throw new Error("Allocations changed during reversal");
      await transaction.saveActivity({ id: `activity:${plan.id}`, type: "system", actor: "admin", occurredAt: new Date(options.occurredAt).toISOString(),
        summary: `Owner-instructed charge reversals ${plan.id}; actor ${options.actorSubject}; plan ${planSha256}; ${allEntries.length} linked reversals; no payments or receipts.` });
      const result: ChargeReversalResult = { token, planSha256, changes, paymentsCreated: 0 };
      if (options.mode === "plan") throw new ReversalRollback(result);
      return result;
    }, { lockTransactionIds: allEntries.map(row => row.chargeId) });
  } catch (error) {
    if (error instanceof ReversalRollback && options.mode === "plan") return error.result;
    throw error;
  }
}
