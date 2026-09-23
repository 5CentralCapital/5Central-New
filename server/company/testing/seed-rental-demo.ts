import type { RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import { syntheticRentOpsSnapshot } from "../../rent-ops/fixtures/synthetic";
import { SYNTHETIC_COMPANY } from "./synthetic-database";

/**
 * The company browser fixture is intentionally seeded through the same
 * Postgres repository used by the runtime. This keeps reports, Rent
 * Operations routes, and the company property/entity mapping on one database
 * snapshot instead of silently joining two in-memory fixtures.
 */
export interface SeedRentalDemoOptions {
  executor: RentOpsQueryExecutor;
  /** The synthetic owner identity is the only identity allowed to seed it. */
  actorId: string;
  actorRole?: "owner";
  snapshot?: RentOpsSnapshot;
  effectiveFrom?: string;
}

const DEMO_PROPERTY_ENTITY_PERIODS = [
  { id: "30000000-0000-4000-8000-000000000001", propertyId: "demo-property-a" },
  { id: "30000000-0000-4000-8000-000000000002", propertyId: "demo-property-b" },
] as const;

function dateOnly(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

async function prepareExistingMinimalRows(
  executor: RentOpsQueryExecutor,
  snapshot: RentOpsSnapshot,
): Promise<{ readonly propertyIds: ReadonlySet<string>; readonly unitIds: ReadonlySet<string> }> {
  const propertyIds = new Set<string>();
  const unitIds = new Set<string>();
  for (const property of snapshot.properties) {
    const result = await executor.query<Record<string, unknown>>(
      `SELECT id,name,slug,address_line1,address_line2,city,state,postal_code,property_type,state_status,operating_contact
         FROM rent_ops_properties WHERE id = $1`,
      [property.id],
    );
    const row = result.rows[0];
    if (!row) continue;
    const matches = nullableText(row.name) === property.name
      && nullableText(row.slug) === property.slug
      && nullableText(row.address_line1) === (property.address.line1 ?? null)
      && nullableText(row.address_line2) === (property.address.line2 ?? null)
      && nullableText(row.city) === (property.address.city ?? null)
      && nullableText(row.state) === (property.address.state ?? null)
      && nullableText(row.postal_code) === (property.address.postalCode ?? null)
      && nullableText(row.property_type) === (property.propertyType ?? null)
      && nullableText(row.state_status) === (property.state ?? null)
      && nullableText(row.operating_contact) === (property.operatingContact ?? null);
    if (!matches) {
      const legacyBootstrap = property.id === "demo-property-a" && nullableText(row.name) === "Demo property A" && nullableText(row.slug) === "demo-property-a";
      if (!legacyBootstrap) throw new Error(`Synthetic property ${property.id} conflicts with an existing record`);
      await executor.query(
        `UPDATE rent_ops_properties
            SET name=$2,slug=$3,address_line1=$4,address_line2=$5,city=$6,state=$7,postal_code=$8,
                property_type=$9,state_status=$10,operating_contact=$11
          WHERE id=$1`,
        [property.id, property.name, property.slug, property.address.line1, property.address.line2 ?? null, property.address.city, property.address.state, property.address.postalCode, property.propertyType, property.state, property.operatingContact ?? null],
      );
    }
    propertyIds.add(property.id);
  }
  for (const unit of snapshot.units) {
    const result = await executor.query<Record<string, unknown>>(
      `SELECT id,property_id,unit_number,unit_type,bedrooms,bathrooms,square_feet,market_rent_cents,default_deposit_cents,readiness,listing,amenities,access_notes
         FROM rent_ops_units WHERE id = $1`,
      [unit.id],
    );
    const row = result.rows[0];
    if (!row) continue;
    const matches = nullableText(row.property_id) === unit.propertyId
      && nullableText(row.unit_number) === unit.unitNumber
      && nullableText(row.unit_type) === (unit.unitType ?? null)
      && (row.bedrooms === null || row.bedrooms === undefined ? undefined : Number(row.bedrooms)) === unit.bedrooms
      && (row.bathrooms === null || row.bathrooms === undefined ? undefined : Number(row.bathrooms)) === unit.bathrooms
      && (row.square_feet === null || row.square_feet === undefined ? undefined : Number(row.square_feet)) === unit.squareFeet
      && (row.market_rent_cents === null || row.market_rent_cents === undefined ? undefined : Number(row.market_rent_cents)) === unit.marketRentCents
      && (row.default_deposit_cents === null || row.default_deposit_cents === undefined ? undefined : Number(row.default_deposit_cents)) === unit.defaultDepositCents
      && nullableText(row.readiness) === (unit.readiness ?? null)
      && nullableText(row.listing) === (unit.listing ?? null);
    if (!matches) {
      const legacyBootstrap = unit.id === "demo-unit-a-1" && nullableText(row.property_id) === "demo-property-a" && nullableText(row.unit_number) === "1A";
      if (!legacyBootstrap) throw new Error(`Synthetic unit ${unit.id} conflicts with an existing record`);
      await executor.query(
        `UPDATE rent_ops_units
            SET property_id=$2,unit_number=$3,unit_type=$4,bedrooms=$5,bathrooms=$6,square_feet=$7,
                market_rent_cents=$8,default_deposit_cents=$9,readiness=$10,listing=$11,amenities=$12,access_notes=$13
          WHERE id=$1`,
        [unit.id, unit.propertyId, unit.unitNumber, unit.unitType ?? null, unit.bedrooms ?? null, unit.bathrooms ?? null, unit.squareFeet ?? null, unit.marketRentCents ?? null, unit.defaultDepositCents ?? null, unit.readiness, unit.listing, unit.amenities ? JSON.stringify(unit.amenities) : null, unit.accessNotes ?? null],
      );
    }
    unitIds.add(unit.id);
  }
  return { propertyIds, unitIds };
}

function requireOwner(options: SeedRentalDemoOptions): void {
  if (options.actorRole !== "owner" || options.actorId !== SYNTHETIC_COMPANY.actorId) {
    throw new Error("Synthetic rental demo seeding requires the synthetic company owner identity");
  }
}

/**
 * Seed the complete synthetic 5Central Ops snapshot and dated mappings for
 * both demo properties. The operation is deliberately owner-only and should
 * be called once while creating the disposable company fixture; a second run
 * with the same IDs fails rather than replacing posted or immutable rows.
 */
export async function seedRentalDemo(options: SeedRentalDemoOptions): Promise<void> {
  requireOwner(options);
  if (!options.executor.transaction) throw new Error("Synthetic rental demo seeding requires an atomic executor");

  const snapshot = options.snapshot ?? syntheticRentOpsSnapshot();
  const effectiveFrom = options.effectiveFrom ?? "2020-01-01";

  await options.executor.transaction(async transactionExecutor => {
    const repository = new PostgresRentOpsRepository(transactionExecutor, true);
    // This helper runs before the restricted runtime role is installed. The
    // normal repository readiness check intentionally rejects a table owner;
    // the explicit owner identity check above is the guard for this fixture's
    // privileged seed path.
    (repository as unknown as { ready: boolean }).ready = true;

    const existing = await prepareExistingMinimalRows(transactionExecutor, snapshot);

    // Identity and parent rows must exist before any linked operational row.
    for (const property of snapshot.properties) if (!existing.propertyIds.has(property.id)) await repository.saveProperty(property);
    for (const unit of snapshot.units) if (!existing.unitIds.has(unit.id)) await repository.saveUnit(unit);
    for (const person of snapshot.people) await repository.savePerson(person);

    for (const application of snapshot.applications) await repository.saveApplication(application);
    for (const member of snapshot.applicationHouseholdMembers) await repository.saveApplicationHouseholdMember(member);
    for (const requirement of snapshot.applicationRequirements) await repository.saveApplicationRequirement(requirement);

    for (const tenancy of snapshot.tenancies) await repository.saveTenancy(tenancy);
    for (const membership of snapshot.householdMemberships) await repository.saveHouseholdMembership(membership);
    for (const term of snapshot.leaseTerms) await repository.saveLeaseTerm(term);

    if (repository.saveChargeDefinition) {
      for (const definition of snapshot.chargeDefinitions) await repository.saveChargeDefinition(definition);
    } else if (snapshot.chargeDefinitions.length > 0) {
      throw new Error("Synthetic rental demo repository cannot seed charge definitions");
    }
    for (const schedule of snapshot.recurringSchedules) {
      // The in-memory fixture predates the v8 distinction between an exact
      // provider link and a manually entered local link. Preserve the
      // schedule facts while recording the synthetic local relationship as
      // manual so it satisfies the durable source-binding check without
      // inventing provider provenance.
      await repository.saveRecurringSchedule({
        ...schedule,
        chargeDefinitionLinkKnowledge: schedule.chargeDefinitionLinkKnowledge === "exact" ? "manual" : schedule.chargeDefinitionLinkKnowledge,
      });
    }

    // Append-only financial rows are written after their parent definitions.
    for (const transaction of snapshot.ledgerTransactions) await repository.saveLedgerTransaction(transaction);
    for (const allocation of snapshot.paymentAllocations) await repository.savePaymentAllocation(allocation);
    for (const deposit of snapshot.securityDeposits) await repository.saveSecurityDeposit(deposit);
    for (const contract of snapshot.subsidyContracts) await repository.saveSubsidyContract(contract);
    for (const tenant of snapshot.subsidyTenants) await repository.saveSubsidyTenant(tenant);
    for (const payment of snapshot.subsidyPayments) await repository.saveSubsidyPayment(payment);

    for (const document of snapshot.documents) await repository.saveDocument(document);
    for (const activity of snapshot.activityEvents) await repository.saveActivity(activity);

    // The mapping is part of the same transaction as the fixture rows. ON
    // CONFLICT is intentionally limited to the immutable identity; a changed
    // payload is rejected by the identity trigger instead of being replaced.
    for (const mapping of DEMO_PROPERTY_ENTITY_PERIODS) {
      await transactionExecutor.query(
        `INSERT INTO company_property_entity_periods
          (id, organization_id, legal_entity_id, property_id, effective_from)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [mapping.id, SYNTHETIC_COMPANY.organizationId, SYNTHETIC_COMPANY.entityId, mapping.propertyId, effectiveFrom],
      );
      const persisted = await transactionExecutor.query<{ organization_id: string; legal_entity_id: string; property_id: string; effective_from: string }>(
        `SELECT organization_id, legal_entity_id, property_id, effective_from
           FROM company_property_entity_periods WHERE id = $1`,
        [mapping.id],
      );
      const row = persisted.rows[0];
      if (!row || row.organization_id !== SYNTHETIC_COMPANY.organizationId || row.legal_entity_id !== SYNTHETIC_COMPANY.entityId || row.property_id !== mapping.propertyId || dateOnly(row.effective_from) !== effectiveFrom) {
        throw new Error(`Synthetic property/entity mapping ${mapping.propertyId} conflicts with the requested fixture`);
      }
    }
  });
}
