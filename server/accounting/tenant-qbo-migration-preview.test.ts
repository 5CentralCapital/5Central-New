import assert from "node:assert/strict";
import test from "node:test";
import { buildTenantQboMigrationPreview, readTenantQboMigrationPreview, type TenantQboMigrationPreviewInput } from "./tenant-qbo-migration-preview";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

const ORG = "org-synthetic";
const ENTITY = "entity-connected";
const REALM = "realm-1";

function baseInput(overrides: Partial<TenantQboMigrationPreviewInput> = {}): TenantQboMigrationPreviewInput {
  return {
    organizationId: ORG,
    environment: "production",
    asOf: "2026-09-26",
    properties: [{ id: "property-connected" }, { id: "property-local" }, { id: "property-ambiguous" }, { id: "property-before-cutoff" }],
    tenancies: [
      { id: "tenancy-former", sourceSystem: "rent_manager", sourceId: "tenant:former", propertyId: "property-connected", unitId: "unit-1", personId: "person-1", status: "past", endOn: "2025-12-31" },
      { id: "tenancy-current", sourceSystem: "rent_manager", sourceId: "tenant:current", propertyId: "property-connected", unitId: "unit-2", personId: "person-2", status: "current", endOn: null },
      { id: "tenancy-local", sourceSystem: "rent_manager", sourceId: "tenant:local", propertyId: "property-local", unitId: "unit-3", personId: "person-3", status: "past", endOn: "2024-01-01" },
    ],
    entityPeriods: [
      { organizationId: ORG, legalEntityId: ENTITY, propertyId: "property-connected", effectiveFrom: "2025-01-01", effectiveUntil: null },
      { organizationId: ORG, legalEntityId: ENTITY, propertyId: "property-before-cutoff", effectiveFrom: "2025-01-01", effectiveUntil: null },
      { organizationId: ORG, legalEntityId: "entity-local", propertyId: "property-local", effectiveFrom: "2020-01-01", effectiveUntil: null },
      { organizationId: ORG, legalEntityId: "entity-a", propertyId: "property-ambiguous", effectiveFrom: "2025-01-01", effectiveUntil: null },
      { organizationId: ORG, legalEntityId: "entity-b", propertyId: "property-ambiguous", effectiveFrom: "2025-01-01", effectiveUntil: null },
    ],
    bindings: [{ legalEntityId: ENTITY, realmId: REALM, connected: true }],
    customerLinks: [
      { tenancyId: "tenancy-former", legalEntityId: ENTITY, realmId: REALM, customerObjectId: "customer-former" },
      { tenancyId: "tenancy-current", legalEntityId: ENTITY, realmId: REALM, customerObjectId: "customer-current" },
    ],
    postingPolicies: [{ legalEntityId: ENTITY, method: "native_receivables", effectiveFrom: "2025-01-01", effectiveUntil: null, cutoffDate: "2026-01-01", openingBalanceBridgeReference: "bridge-1", invoiceDeliveryVerified: true }],
    transactions: [
      { id: "tx-former", sourceSystem: "rent_manager", sourceId: "charge:former", sourceArtifactSha256: "a".repeat(64), artifactObservationOn: "2026-09-01", sourceUpdatedAt: null, propertyId: "property-connected", unitId: "unit-1", tenancyId: "tenancy-former", personId: "person-1", kind: "charge", category: "base_rent", status: "posted", amountCents: "9007199254740993123", postedOn: "2026-02-01", dueOn: "2026-02-01", paymentMethod: null, description: "synthetic charge", reversalOfId: null, payer: "tenant", adjustmentDirection: null, propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", tenancyLinkKnowledge: "exact", personLinkKnowledge: "exact", amountKnowledge: "known", postedOnKnowledge: "source", sourceUpdatedAt: null },
      { id: "tx-payment", sourceSystem: "rent_manager", sourceId: "payment:current", sourceArtifactSha256: "b".repeat(64), artifactObservationOn: "2026-09-01", sourceUpdatedAt: null, propertyId: "property-connected", unitId: "unit-2", tenancyId: "tenancy-current", personId: "person-2", kind: "payment", category: "base_rent", status: "posted", amountCents: "12500", postedOn: "2026-02-02", dueOn: null, paymentMethod: "ach", description: "synthetic payment", reversalOfId: null, payer: "tenant", adjustmentDirection: null, propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", tenancyLinkKnowledge: "exact", personLinkKnowledge: "exact", amountKnowledge: "known", postedOnKnowledge: "source", sourceUpdatedAt: null },
      { id: "tx-credit", sourceSystem: "rent_manager", sourceId: "credit:current", sourceArtifactSha256: "c".repeat(64), artifactObservationOn: "2026-09-01", sourceUpdatedAt: null, propertyId: "property-connected", unitId: "unit-2", tenancyId: "tenancy-current", personId: "person-2", kind: "credit", category: "other", status: "posted", amountCents: "125", postedOn: "2026-02-03", dueOn: null, paymentMethod: null, description: "synthetic credit", reversalOfId: null, payer: "tenant", adjustmentDirection: null, propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", tenancyLinkKnowledge: "exact", personLinkKnowledge: "exact", amountKnowledge: "known", postedOnKnowledge: "source", sourceUpdatedAt: null },
      { id: "tx-local", sourceSystem: "rent_manager", sourceId: "charge:local", sourceArtifactSha256: "d".repeat(64), artifactObservationOn: "2026-09-01", sourceUpdatedAt: null, propertyId: "property-local", unitId: "unit-3", tenancyId: "tenancy-local", personId: "person-3", kind: "charge", category: "base_rent", status: "posted", amountCents: "1000", postedOn: "2026-02-04", dueOn: "2026-02-04", paymentMethod: null, description: "local synthetic charge", reversalOfId: null, payer: "tenant", adjustmentDirection: null, propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", tenancyLinkKnowledge: "exact", personLinkKnowledge: "exact", amountKnowledge: "known", postedOnKnowledge: "source", sourceUpdatedAt: null },
      { id: "tx-ambiguous", sourceSystem: "rent_manager", sourceId: "charge:ambiguous", sourceArtifactSha256: "e".repeat(64), artifactObservationOn: "2026-09-01", sourceUpdatedAt: null, propertyId: "property-ambiguous", unitId: null, tenancyId: null, personId: null, kind: "charge", category: "base_rent", status: "posted", amountCents: "100", postedOn: "2026-02-05", dueOn: null, paymentMethod: null, description: "ambiguous synthetic charge", reversalOfId: null, payer: null, adjustmentDirection: null, propertyLinkKnowledge: null, unitLinkKnowledge: null, tenancyLinkKnowledge: null, personLinkKnowledge: null, amountKnowledge: "known", postedOnKnowledge: "source", sourceUpdatedAt: null },
      { id: "tx-before-cutoff", sourceSystem: "rent_manager", sourceId: "charge:before", sourceArtifactSha256: "f".repeat(64), artifactObservationOn: "2026-09-01", sourceUpdatedAt: null, propertyId: "property-before-cutoff", unitId: null, tenancyId: "tenancy-current", personId: "person-2", kind: "charge", category: "base_rent", status: "posted", amountCents: "200", postedOn: "2025-12-31", dueOn: null, paymentMethod: null, description: "before cutoff", reversalOfId: null, payer: "tenant", adjustmentDirection: null, propertyLinkKnowledge: "exact", unitLinkKnowledge: "exact", tenancyLinkKnowledge: "exact", personLinkKnowledge: "exact", amountKnowledge: "known", postedOnKnowledge: "source", sourceUpdatedAt: null },
    ],
    allocations: [
      { id: "allocation-local", sourceSystem: "rent_manager", sourceId: "allocation:local", sourceArtifactSha256: "1".repeat(64), artifactObservationOn: "2026-09-01", sourceUpdatedAt: null, sourcePropertyId: "property-local", kind: "allocation", paymentTransactionId: "tx-local", chargeTransactionId: "tx-local", creditTransactionId: null, amountCents: "100", allocatedOn: "2026-02-04", paymentLinkKnowledge: "exact", chargeLinkKnowledge: "exact", creditLinkKnowledge: null, amountKnowledge: "known", allocatedOnKnowledge: "source" },
      { id: "allocation-cross", sourceSystem: "rent_manager", sourceId: "allocation:cross", sourceArtifactSha256: "2".repeat(64), artifactObservationOn: "2026-09-01", sourceUpdatedAt: null, sourcePropertyId: "property-connected", kind: "allocation", paymentTransactionId: "tx-former", chargeTransactionId: "tx-local", creditTransactionId: null, amountCents: "50", allocatedOn: "2026-02-04", paymentLinkKnowledge: "exact", chargeLinkKnowledge: "exact", creditLinkKnowledge: null, amountKnowledge: "known", allocatedOnKnowledge: "source" },
    ],
    ...overrides,
  };
}

const findTransaction = (preview: ReturnType<typeof buildTenantQboMigrationPreview>, id: string) => preview.transactions.find(row => row.transactionId === id)!;
const findAllocation = (preview: ReturnType<typeof buildTenantQboMigrationPreview>, id: string) => preview.allocations.find(row => row.allocationId === id)!;

test("builds a source-linked exact-cents preview with former, local, unsupported, and ambiguous rows", () => {
  const preview = buildTenantQboMigrationPreview(baseInput());
  const former = findTransaction(preview, "tx-former");
  assert.deepEqual([former.route, former.eligibility, former.formerTenancy, former.targetObjectType, former.amountCents, former.customerObjectId], ["native_qbo", "eligible", true, "Invoice", "9007199254740993123", "customer-former"]);
  assert.deepEqual([findTransaction(preview, "tx-payment").route, findTransaction(preview, "tx-payment").eligibility], ["hold", "hold"]);
  assert.ok(findTransaction(preview, "tx-payment").holdReasons.includes("qbo_object_write_unsupported"));
  assert.ok(findTransaction(preview, "tx-credit").holdReasons.includes("qbo_object_write_unsupported"));
  assert.deepEqual([findTransaction(preview, "tx-local").route, findTransaction(preview, "tx-local").eligibility], ["local_rops", "local_only"]);
  assert.ok(findTransaction(preview, "tx-ambiguous").holdReasons.includes("overlapping_entity_periods"));
  assert.ok(findTransaction(preview, "tx-before-cutoff").holdReasons.includes("before_posting_policy_cutoff"));
  assert.deepEqual([findAllocation(preview, "allocation-local").route, findAllocation(preview, "allocation-local").eligibility], ["local_rops", "local_only"]);
  assert.ok(findAllocation(preview, "allocation-cross").holdReasons.includes("allocation_crosses_qbo_and_local_scope"));
  assert.equal(preview.totals.transactionAmountByKindCents.charge, "9007199254740994423");
  assert.equal(preview.readOnly, true);
  assert.match(preview.previewSha256, /^[a-f0-9]{64}$/);
});

test("unmapped properties are explicit holds and never local-only rows", () => {
  const input = baseInput();
  const row = { ...input.transactions[0]!, id: "tx-unmapped", propertyId: "property-unmapped", unitId: null, tenancyId: null, personId: null, sourceId: "charge:unmapped" };
  const preview = buildTenantQboMigrationPreview({ ...input, properties: [...input.properties, { id: "property-unmapped" }], transactions: [...input.transactions, row] });
  const unmapped = findTransaction(preview, "tx-unmapped");
  assert.deepEqual([unmapped.route, unmapped.eligibility], ["hold", "hold"]);
  assert.ok(unmapped.holdReasons.includes("property_not_assigned_to_company"));
});

test("readTenantQboMigrationPreview reads persisted R-ops tables without a write-capable query", async () => {
  const input = baseInput();
  const crossOrgTransaction = {
    ...input.transactions[0]!,
    id: "tx-cross-org",
    sourceId: "charge:cross-org",
    propertyId: "property-other-org",
    tenancyId: null,
    unitId: null,
    personId: null,
  };
  const dbInput: TenantQboMigrationPreviewInput = {
    ...input,
    properties: [...input.properties, { id: "property-other-org" }],
    entityPeriods: [...input.entityPeriods, { organizationId: "org-other", legalEntityId: "entity-other", propertyId: "property-other-org", effectiveFrom: "2025-01-01", effectiveUntil: null }],
    transactions: [...input.transactions, crossOrgTransaction],
  };
  let bindingConnected = true;
  const queries: string[] = [];
  const rows = (sql: string, values?: unknown[]): readonly Record<string, unknown>[] => {
    if (sql.includes("SELECT id FROM rent_ops_properties")) {
      const mappedIds = (values?.[0] as string[] | undefined) ?? [];
      return dbInput.properties.filter(row => mappedIds.includes(row.id)).map(row => ({ id: row.id }));
    }
    if (sql.includes("FROM rent_ops_tenancies")) {
      const ids = (values?.[0] as string[] | undefined) ?? [];
      return dbInput.tenancies.filter(row => ids.includes(row.propertyId ?? "")).map(row => ({ id: row.id, source_system: row.sourceSystem, source_id: row.sourceId, property_id: row.propertyId, unit_id: row.unitId, primary_person_id: row.personId, status: row.status, end_on: row.endOn }));
    }
    if (sql.includes("FROM company_property_entity_periods")) {
      const organizationId = String(values?.[0] ?? "");
      return dbInput.entityPeriods.filter(row => row.organizationId === organizationId).map(row => ({ organization_id: row.organizationId, legal_entity_id: row.legalEntityId, property_id: row.propertyId, effective_from: row.effectiveFrom, effective_until: row.effectiveUntil }));
    }
    if (sql.includes("FROM accounting_qbo_realm_bindings")) return dbInput.bindings.map(row => ({ legal_entity_id: row.legalEntityId, realm_id: row.realmId, connected: bindingConnected && row.connected !== false }));
    if (sql.includes("FROM company_external_identities")) {
      const tenancyIds = (values?.[2] as string[] | undefined) ?? [];
      return dbInput.customerLinks.filter(row => tenancyIds.includes(row.tenancyId)).map(row => ({ local_id: row.tenancyId, legal_entity_id: row.legalEntityId, source_scope: `qbo:production:${row.realmId}`, external_id: row.customerObjectId }));
    }
    if (sql.includes("FROM accounting_rental_posting_policies")) return dbInput.postingPolicies.map(row => ({ legal_entity_id: row.legalEntityId, method: row.method, effective_from: row.effectiveFrom, effective_until: row.effectiveUntil, cutoff_date: row.cutoffDate, opening_balance_bridge_reference: row.openingBalanceBridgeReference, invoice_delivery_verified: row.invoiceDeliveryVerified }));
    if (sql.includes("FROM rent_ops_ledger_transactions")) {
      const ids = (values?.[0] as string[] | undefined) ?? [];
      return dbInput.transactions.filter(row => ids.includes(row.propertyId ?? "")).map(row => ({
        id: row.id, source_system: row.sourceSystem, source_id: row.sourceId, source_artifact_sha256: row.sourceArtifactSha256,
        artifact_observation_on: row.artifactObservationOn, source_updated_at: row.sourceUpdatedAt, property_id: row.propertyId,
        unit_id: row.unitId, tenancy_id: row.tenancyId, person_id: row.personId, kind: row.kind, category: row.category,
        status: row.status, amount_cents: row.amountCents, posted_on: row.postedOn, due_on: row.dueOn, payment_method: row.paymentMethod,
        description: row.description, reversal_of_id: row.reversalOfId, payer: row.payer, adjustment_direction: row.adjustmentDirection,
        property_link_knowledge: row.propertyLinkKnowledge, unit_link_knowledge: row.unitLinkKnowledge,
        tenancy_link_knowledge: row.tenancyLinkKnowledge, person_link_knowledge: row.personLinkKnowledge,
        amount_knowledge: row.amountKnowledge, posted_on_knowledge: row.postedOnKnowledge,
      }));
    }
    if (sql.includes("FROM rent_ops_payment_allocations")) {
      const propertyIds = (values?.[0] as string[] | undefined) ?? [];
      const transactionIds = (values?.[1] as string[] | undefined) ?? [];
      return dbInput.allocations.filter(row => propertyIds.includes(row.sourcePropertyId ?? "") || [row.paymentTransactionId, row.chargeTransactionId, row.creditTransactionId].some(id => id !== null && transactionIds.includes(id))).map(row => ({
        id: row.id, source_system: row.sourceSystem, source_id: row.sourceId, source_artifact_sha256: row.sourceArtifactSha256,
        artifact_observation_on: row.artifactObservationOn, source_updated_at: row.sourceUpdatedAt, source_property_id: row.sourcePropertyId,
        kind: row.kind, payment_transaction_id: row.paymentTransactionId, charge_transaction_id: row.chargeTransactionId,
        credit_transaction_id: row.creditTransactionId, amount_cents: row.amountCents, allocated_on: row.allocatedOn,
        payment_link_knowledge: row.paymentLinkKnowledge, charge_link_knowledge: row.chargeLinkKnowledge,
        credit_link_knowledge: row.creditLinkKnowledge, amount_knowledge: row.amountKnowledge, allocated_on_knowledge: row.allocatedOnKnowledge,
      }));
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const executor: RentOpsQueryExecutor = { query: async <T>(sql: string, values?: unknown[]) => { queries.push(sql); assert.match(sql.trim().toUpperCase(), /^SELECT/); return { rows: rows(sql, values) as T[] }; } };
  const preview = await readTenantQboMigrationPreview(executor, { organizationId: ORG, environment: "production", asOf: "2026-09-26" });
  assert.equal(preview.transactions.length, input.transactions.length);
  assert.equal(findTransaction(preview, "tx-cross-org"), undefined);
  assert.equal(findTransaction(preview, "tx-former").amountCents, "9007199254740993123");
  assert.equal(queries.length, 8);
  assert.match(queries.find(sql => sql.includes("FROM rent_ops_ledger_transactions"))!, /WHERE property_id = ANY/i);
  assert.match(queries.find(sql => sql.includes("FROM rent_ops_tenancies"))!, /WHERE property_id = ANY/i);
  assert.match(queries.find(sql => sql.includes("FROM accounting_qbo_realm_bindings"))!, /accounting_qbo_connections/);
  assert.match(queries.find(sql => sql.includes("FROM accounting_qbo_realm_bindings"))!, /accounting_qbo_capabilities/);
  assert.equal(queries.every(sql => !/\b(?:INSERT|UPDATE|DELETE)\b|\bFOR\s+UPDATE\b/i.test(sql)), true);

  bindingConnected = false;
  const disconnectedPreview = await readTenantQboMigrationPreview(executor, { organizationId: ORG, environment: "production", asOf: "2026-09-26" });
  assert.deepEqual([findTransaction(disconnectedPreview, "tx-former").route, findTransaction(disconnectedPreview, "tx-former").eligibility], ["local_rops", "local_only"]);
});
