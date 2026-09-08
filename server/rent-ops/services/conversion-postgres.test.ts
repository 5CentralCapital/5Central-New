import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { eligibleTenantTenancies, presentTenantHome } from "../tenant-portal/presentation";
import { RentOpsService, type ApplicationConversionFacts } from "./service";

test("PostgreSQL prospect conversion commits one audited schedule and rolls back on audit failure", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    await db.exec("CREATE ROLE qa_conversion_runtime; GRANT USAGE ON SCHEMA public TO qa_conversion_runtime");
    for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO qa_conversion_runtime`);
    await db.exec("SET ROLE qa_conversion_runtime");
    let failAudit = false;
    const adapt = (connection: any): RentOpsQueryExecutor => ({
      query: async (sql, values) => {
        if (failAudit && /^INSERT INTO rent_ops_record_changes\b/.test(sql)) throw new Error("synthetic audit unavailable");
        return connection.query(sql, values?.map(value => value === undefined ? null : value));
      },
      transaction: async work => connection.transaction ? connection.transaction((tx: any) => work(adapt(tx))) : work(adapt(connection)),
    });
    const repo = new PostgresRentOpsRepository(adapt(db));
    await repo.saveProperty({ id: "p", name: "Synthetic homes", slug: "synthetic", address: { line1: "1 Example Street", city: "Example", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: "active" });
    await repo.saveUnit({ id: "u", propertyId: "p", unitNumber: "1", readiness: "ready", listing: "listed", propertyLinkKnowledge: "manual", readinessKnowledge: "manual", listingKnowledge: "manual" });
    await repo.saveChargeDefinition({ id: "rent", displayName: "Rent", displayNameKnowledge: "manual", category: "base_rent", categoryKnowledge: "manual", active: true, activeKnowledge: "manual" });
    const service = new RentOpsService(repo, () => new Date("2026-09-07T12:00:00Z"), undefined, undefined, true);
    const started = await service.startApplication({ email: "applicant@example.test", firstName: "Synthetic", lastName: "Applicant", phone: "555-0100", currentAddress: "1 Example Street" });
    const id = started.application.id;
    await service.savePublicApplication(started.resumeToken!, { propertyId: "p", unitId: "u", preferences: { desiredMoveInOn: "2026-10-01", desiredLeaseMonths: 12 } });
    await service.certifyPublicApplication(started.resumeToken!);
    await service.submitPublicApplication(started.resumeToken!);
    await service.updateApplicationStatus(id, "approved");
    const facts: ApplicationConversionFacts = { propertyId: "p", unitId: "u", plannedMoveInOn: "2026-10-01", leaseStatus: "executed", contractStartOn: "2026-10-01", contractEndOn: "2027-09-30", monthToMonth: false, baseRentCents: 125000, chargeDefinitionId: "rent", category: "base_rent", scheduleDescription: "Monthly rent", primaryFinanciallyResponsible: true, members: [{ applicationMemberId: "primary", role: "primary", isFinanciallyResponsible: true }] };
    const context = { actorSubject: "qa-operator", occurredAt: "2026-09-07T12:00:00.000Z" };
    failAudit = true;
    await assert.rejects(service.convertApplication(id, facts, context), /synthetic audit unavailable/);
    let snapshot = await repo.getSnapshot();
    assert.equal(snapshot.tenancies.length, 0);
    assert.equal(snapshot.recurringSchedules.length, 0);
    assert.equal(snapshot.people.length, 0);
    assert.equal(snapshot.applications.find(row => row.id === id)?.convertedTenancyId, undefined);
    failAudit = false;
    const converted = await service.convertApplication(id, facts, context);
    assert.equal((await service.convertApplication(id, facts, context)).tenancy.id, converted.tenancy.id);
    snapshot = await repo.getSnapshot();
    assert.equal(snapshot.tenancies.length, 1);
    assert.equal(snapshot.recurringSchedules.length, 1);
    assert.equal(snapshot.leaseTerms.length, 1);
    assert.equal(snapshot.householdMemberships.length, 1);
    assert.equal(eligibleTenantTenancies(snapshot)[0]?.tenancyId, converted.tenancy.id);
    const home = presentTenantHome(snapshot, { id: "qa-account", email: "applicant@example.test", personId: converted.tenancy.primaryPersonId, tenancyId: converted.tenancy.id, status: "active" }, "2026-09-07");
    assert.equal(home?.leases[0]?.startDate, facts.contractStartOn);
    assert.equal(home?.leases[0]?.endDate, facts.contractEndOn);
    const changes = await repo.getRecordChanges();
    const change = changes.find(row => row.targetId === snapshot.recurringSchedules[0].id)!;
    assert.equal(change.revision, 1);
    assert.equal(change.actorSubject, "qa-operator");
    assert.equal(changes.filter(row => row.targetId === change.targetId).length, 1);
    await assert.rejects(repo.saveRecordChange({ ...change, id: "bad-property-audit", entityType: "property", targetId: "p", changedFields: ["name"] }), /constraint/);
  } finally { await db.close(); }
});
