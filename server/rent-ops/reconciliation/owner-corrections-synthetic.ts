/** Synthetic owner-correction scenario: fictional people, fictional IDs, fictional amounts. */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { RentOpsLedgerTransaction, RentOpsSnapshot, RentOpsTenancy } from "../../../shared/rent-ops-contracts";
import { emptyRentOpsSnapshot } from "../../../shared/rent-ops-contracts";

export const SYNTHETIC_OCCURRED_AT = "2026-09-23T13:00:00.000Z";
const created = "2026-01-01T12:00:00.000Z";
const src = (entityType: string, sourceId: string) => ({ system: "rent_manager" as const, entityType, sourceId });

export const SYNTHETIC_IDS = {
  property: "syn-property", cancelPerson: "syn:person:cancel", zeroPerson: "syn:person:zero", reversePerson: "syn:person:reverse",
  futurePerson: "syn:person:future", paymentGapPerson: "syn:person:payment-gap",
  cancelTenancy: "syn-tenancy-cancel", zeroTenancy: "syn-tenancy-zero", reverseTenancy: "syn-tenancy-reverse", futureTenancy: "syn-tenancy-future", paymentGapTenancy: "syn-tenancy-payment-gap",
  rentCharge: "syn-charge-rent", feeCharge: "syn-charge-fee", gapCharge: "syn-charge-gap", gapPayment: "syn-payment-gap",
} as const;

function tenancy(id: string, personId: string, unitId: string, status: RentOpsTenancy["status"], extra: Partial<RentOpsTenancy> = {}): RentOpsTenancy {
  return { id, source: src("tenancy", `lease:${id}`), recordRevision: 1, propertyId: SYNTHETIC_IDS.property, unitId, primaryPersonId: personId, status, statusKnowledge: "source",
    createdAt: created, createdAtKnowledge: "source", propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", primaryPersonLinkKnowledge: "exact",
    actualMoveInKnowledge: "unknown", actualMoveOutKnowledge: "unknown", ...extra };
}
function charge(id: string, personId: string, tenancyId: string, unitId: string, kind: "charge" | "payment", category: RentOpsLedgerTransaction["category"], amountCents: number, postedOn: string, description: string): RentOpsLedgerTransaction {
  return { id, source: src("transaction", `tx:${id}`), sourceArtifactSha256: "a".repeat(64), artifactObservationOn: "2026-09-01", propertyId: SYNTHETIC_IDS.property, unitId, tenancyId, personId, kind, category,
    categoryKnowledge: "source", status: "posted", statusKnowledge: "source", amountCents, amountKnowledge: "known", postedOn, postedOnKnowledge: "source", dueOn: kind === "charge" ? postedOn : null,
    dueOnKnowledge: kind === "charge" ? "source" : "unknown", paymentMethod: kind === "payment" ? "zelle" : null, paymentMethodKnowledge: kind === "payment" ? "source" : "unknown", description,
    descriptionKnowledge: "source", reversalOfId: null, payer: "tenant", payerKnowledge: "source", adjustmentDirection: null, propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact",
    tenancyLinkKnowledge: "exact", personLinkKnowledge: "exact", allocationMode: null, chargeDefinitionId: null, chargeDefinitionLinkKnowledge: "unknown" };
}

export function syntheticOwnerCorrectionSnapshot(): RentOpsSnapshot {
  const snapshot = emptyRentOpsSnapshot();
  const I = SYNTHETIC_IDS;
  snapshot.properties.push({ id: I.property, recordRevision: 1, source: src("property", "prop:1"), name: "Example Court", slug: "example-court",
    address: { line1: "1 Example Way", city: "Sampleton", state: "ZZ", postalCode: "00001" }, propertyType: "multifamily", state: "active" });
  for (const n of [1, 2, 3, 4, 5, 6]) snapshot.units.push({ id: `syn-unit-${n}`, recordRevision: 1, source: src("unit", `unit:${n}`), propertyId: I.property, unitNumber: `#${n}`, propertyLinkKnowledge: "exact" } as any);
  const person = (id: string, firstName: string, lastName: string, n: number) => snapshot.people.push({ id, recordRevision: 1, source: src("person", `tenant:${n}`), firstName, lastName });
  person(I.cancelPerson, "Avery", "Samplecancel", 101); person(I.zeroPerson, "Blake", "Samplezero", 102); person(I.reversePerson, "Casey", "Samplereverse", 103);
  person(I.paymentGapPerson, "Emery", "Samplegap", 105);
  // Future resident known only through source account facts; the imported tenancy's unit link is unresolved.
  snapshot.people.push({ id: I.futurePerson, recordRevision: 1, firstName: "Devon", lastName: "Samplefuture", sourceAccountFacts: { status: "future", rawStatus: "Future", statusKnowledge: "source",
    postingStartOn: null, postingEndOn: null, postingStartKnowledge: "unknown", postingEndKnowledge: "unknown", observedOn: "2026-09-01", artifactSha256: "b".repeat(64) } });
  snapshot.tenancies.push(
    tenancy(I.cancelTenancy, I.cancelPerson, "syn-unit-1", "past", { actualMoveInOn: "2026-06-01", actualMoveInKnowledge: "source", actualMoveOutOn: "2026-07-31", actualMoveOutKnowledge: "source" }),
    tenancy(I.zeroTenancy, I.zeroPerson, "syn-unit-2", "past", { actualMoveOutOn: "2026-01-16", actualMoveOutKnowledge: "source" }),
    tenancy(I.reverseTenancy, I.reversePerson, "syn-unit-3", "past", { actualMoveOutOn: "2026-08-31", actualMoveOutKnowledge: "source" }),
    tenancy(I.futureTenancy, I.futurePerson, "syn-unit-4", "future", { unitLinkKnowledge: "unknown", plannedMoveInOn: "2026-09-01", plannedMoveInKnowledge: "source" }),
    tenancy(I.paymentGapTenancy, I.paymentGapPerson, "syn-unit-6", "current", { actualMoveInOn: "2026-08-01", actualMoveInKnowledge: "source" }),
  );
  snapshot.ledgerTransactions.push(
    charge(I.rentCharge, I.reversePerson, I.reverseTenancy, "syn-unit-3", "charge", "base_rent", 111100, "2026-08-01", "Synthetic rent"),
    charge(I.feeCharge, I.reversePerson, I.reverseTenancy, "syn-unit-3", "charge", "one_time_fee", 22200, "2026-08-01", "Synthetic fee"),
    charge(I.gapCharge, I.paymentGapPerson, I.paymentGapTenancy, "syn-unit-6", "charge", "base_rent", 90000, "2026-09-01", "Synthetic rent"),
    charge(I.gapPayment, I.paymentGapPerson, I.paymentGapTenancy, "syn-unit-6", "payment", "other", 45000, "2026-09-05", "Synthetic receipt"),
  );
  return snapshot;
}

const before = (unit: string, tenant: string, status: string, operational: string, posted: string) => ({ Property: "Example Court", Unit: unit, Tenant: tenant, "Tenant status": status, "Operational balance": operational, "Posted ledger total": posted });

export function syntheticCorrectionPackage() {
  const I = SYNTHETIC_IDS;
  const proposed = {
    as_of: "2026-09-23", status: "PREPARED_NOT_APPLIED", automatic_execution_allowed: false, fresh_read_required_before_application: true,
    controls: ["Synthetic control: unknown stays unknown.", "Synthetic control: no balancing entries."],
    cases: [
      { tenant: "Avery Samplecancel", research_status: "OCCUPANCY_RESOLVED_OWNER_ATTESTED", application_status: "NOT_APPLIED", before: before("#1", "Avery Samplecancel", "Former", "Needs review", "Needs review"),
        person_id: I.cancelPerson, confirmed_facts: ["Synthetic: never occupied."], proposed_actions: ["Mark the synthetic tenancy cancelled and keep its history."], unresolved: ["Synthetic: amount owed not given."], evidence: ["owner-instructions.json"] },
      { tenant: "Blake Samplezero", research_status: "ZERO_BALANCE_RESOLVED_OWNER_ATTESTED", application_status: "NOT_APPLIED", before: before("#2", "Blake Samplezero", "Former", "Needs review", "Needs review"),
        person_id: I.zeroPerson, confirmed_facts: ["Synthetic: owner says nothing is owed."], proposed_actions: ["Record the synthetic zero balance.", "Apply a correction/reversal to any synthetic imported charges."], unresolved: ["Synthetic: exact end date unknown."], evidence: ["owner-instructions.json"] },
      { tenant: "Casey Samplereverse", research_status: "ZERO_CHARGE_CORRECTION_RESOLVED_OWNER_INSTRUCTED", application_status: "NOT_APPLIED", before: before("#3", "Casey Samplereverse", "Former", "$1,333.00", "$1,333.00"),
        person_id: I.reversePerson, confirmed_facts: ["Synthetic: owner instructs removing the charges."], proposed_actions: ["Post reversals for each synthetic charge.", "Mark the synthetic tenancy cancelled."], unresolved: ["Synthetic: re-read charges before applying."], evidence: ["owner-instructions.json", "live-account-inventory.json"] },
      { tenant: "Devon Samplefuture", research_status: "UNIT_AND_FUTURE_TERM_RESOLVED", application_status: "NOT_APPLIED", before: before("Needs review", "Devon Samplefuture", "Future", "$0.00", "$0.00"),
        person_id: I.futurePerson, confirmed_facts: ["Synthetic signed lease names unit #5."], proposed_actions: ["Attach the synthetic future tenancy to its unit.", "Match the synthetic deposit receipt separately."], unresolved: ["Synthetic: no occupancy before the start date."], evidence: ["owner-instructions.json"] },
      { tenant: "Emery Samplegap", research_status: "RECEIPTS_EXIST_ALLOCATION_OPEN", application_status: "NOT_APPLIED", before: before("#6", "Emery Samplegap", "Current", "$450.00", "$450.00"),
        person_id: I.paymentGapPerson, confirmed_facts: ["Synthetic receipt exists."], proposed_actions: ["Match the synthetic receipt to a period."], unresolved: ["Synthetic: period unknown."], evidence: ["live-payment-observations.json"] },
    ],
  };
  const owner = { recorded_date: "2026-09-23", application_status: "NOT_APPLIED", facts: [
    { tenant: "Avery Samplecancel", facts: ["Synthetic fact"] }, { tenant: "Blake Samplezero", facts: ["Synthetic fact"] },
    { tenant: "Casey Samplereverse", facts: ["Synthetic fact"], owner_instruction: "Synthetic instruction: remove the charges", observed_before: { operational_balance_cents: 133300, posted_ledger_total_cents: 133300 } },
  ] };
  const remaining = { application_status: "NOT_APPLIED", all_cases_cleared: false, items: [
    { case: "Emery Samplegap receipt", missing: "Synthetic: receipt period" }, { case: "Synthetic portfolio item", missing: "Synthetic: dates" },
  ] };
  const inventory = { scope: "synthetic", count: 5, accounts: [] };
  const payments = { application_status: "NOT_APPLIED", accounts: [] };
  const resolutions = { version: 1, cases: [{ personId: I.futurePerson, futureUnitLink: { unitNumber: "#5", plannedMoveInOn: "2026-10-01", evidenceReference: "Synthetic signed lease, page 1" } }] };
  return { proposed, owner, remaining, inventory, payments, resolutions };
}

/** Writes the synthetic package (and a package manifest with real hashes) into `directory`. */
export async function writeSyntheticCorrectionPackage(directory: string, mutate?: (value: ReturnType<typeof syntheticCorrectionPackage>) => void) {
  const value = syntheticCorrectionPackage();
  mutate?.(value);
  await mkdir(directory, { recursive: true });
  const files: Record<string, unknown> = { "proposed-corrections.json": value.proposed, "owner-instructions.json": value.owner, "remaining-evidence.json": value.remaining,
    "live-account-inventory.json": value.inventory, "live-payment-observations.json": value.payments };
  const manifest: Array<{ path: string; sha256: string }> = [];
  for (const [name, body] of Object.entries(files)) {
    const bytes = Buffer.from(JSON.stringify(body, null, 1));
    await writeFile(join(directory, name), bytes);
    manifest.push({ path: `/synthetic/package/${name}`, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(join(directory, "package-manifest.json"), JSON.stringify({ status: "VERIFIED_FILES_NOT_APPLIED", files: manifest }));
  const resolutionsPath = join(directory, "..", `${directory.split("/").pop()}-resolutions.json`);
  await writeFile(resolutionsPath, JSON.stringify(value.resolutions));
  return { directory, resolutionsPath };
}
