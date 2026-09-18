import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from "../persistence";
import { PostgresRentOpsRepository, type RentOpsQueryExecutor } from "../repositories/postgres";
import { RentOpsService } from "./service";

const context = { actorSubject: "qa-admin", occurredAt: "2026-09-17T12:00:00.000Z" };

async function setup() {
  const db = new PGlite();
  await ensureRentOpsSchema({ apply: true, executor: async (sql) => { await db.exec(sql); } });
  await db.exec("CREATE ROLE qa_operations; GRANT USAGE ON SCHEMA public TO qa_operations");
  for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES) {
    await db.exec(`GRANT ${table === "rent_ops_schema_migrations" ? "SELECT" : ["rent_ops_ledger_transactions", "rent_ops_payment_allocations"].includes(table) ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE"} ON ${table} TO qa_operations`);
  }
  await db.exec("SET ROLE qa_operations");
  const adapt = (connection: any): RentOpsQueryExecutor => ({
    query: async (sql, values) => connection.query(sql, values?.map((value) => value === undefined ? null : value)),
    transaction: async (work) => connection.transaction ? connection.transaction((tx: any) => work(adapt(tx))) : work(adapt(connection)),
  });
  const service = new RentOpsService(new PostgresRentOpsRepository(adapt(db)));
  await db.exec(`
    INSERT INTO rent_ops_properties(id,name,slug,address_line1,city,state,postal_code,property_type)
      VALUES('p','QA','qa','1 QA','QA','FL','00000','multifamily');
    INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge)
      VALUES('u','p','1','manual');
    INSERT INTO rent_ops_people(id,first_name,last_name)
      VALUES('person','QA','Resident');
    INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,
      property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)
      VALUES('t','p','u','person','current',NOW(),'manual','manual','manual','manual');
  `);
  const saveCharge = (id: string, amountCents: number, postedOn: string, options: { category?: "base_rent" | "security_deposit" | "recurring_fee" | "one_time_fee"; dueOn?: string; payer?: "tenant" | "agency" } = {}) => service.saveLedgerTransaction({
    id, propertyId: "p", unitId: "u", tenancyId: "t", personId: "person", kind: "charge",
    category: options.category ?? "base_rent", amountCents, postedOn, dueOn: options.dueOn ?? postedOn,
    status: "posted", description: id, payer: options.payer ?? "tenant", paymentMethod: null,
    categoryKnowledge: "manual", amountKnowledge: "known", postedOnKnowledge: "manual", dueOnKnowledge: "manual",
    statusKnowledge: "manual", descriptionKnowledge: "manual", payerKnowledge: "manual",
    propertyLinkKnowledge: "manual", unitLinkKnowledge: "manual", tenancyLinkKnowledge: "manual", personLinkKnowledge: "manual",
    chargeDefinitionId: null, chargeDefinitionLinkKnowledge: "unknown", paymentMethodKnowledge: "unknown",
  });
  return { db, service, saveCharge, close: () => db.close() };
}

test("manual payment defaults to oldest-charge auto-allocation, includes deposits, and replays exactly", async () => {
  const { db, service, saveCharge, close } = await setup();
  try {
    await saveCharge("charge-01", 1000, "2026-09-01");
    await saveCharge("charge-02", 500, "2026-09-01", { category: "security_deposit" });
    await saveCharge("charge-03", 1000, "2026-09-02", { category: "recurring_fee" });
    await saveCharge("charge-future", 1000, "2026-09-10");

    const input = { id: "payment-auto", tenancyId: "t", amountCents: 1800, postedOn: "2026-09-03", paymentMethod: "cash" as const, description: "Receipt", category: "base_rent" as const, allocations: [] };
    const first = await service.recordManualPayment(input, context);
    assert.equal(first.replayed, false);
    assert.deepEqual(first.allocations.map((row) => [row.chargeTransactionId, row.amountCents]), [["charge-01", 1000], ["charge-02", 500], ["charge-03", 300]]);
    assert.equal(first.allocatedCents, 1800);
    assert.equal(first.unappliedCents, 0);
    assert.equal((await service.snapshot()).paymentAllocations.some((row) => row.chargeTransactionId === "charge-future"), false);

    const replay = await service.recordManualPayment(input, context);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.allocations.map((row) => [row.chargeTransactionId, row.amountCents]), first.allocations.map((row) => [row.chargeTransactionId, row.amountCents]));
    assert.equal((await service.snapshot()).paymentAllocations.filter((row) => row.paymentTransactionId === "payment-auto").length, 3);

    const explicitDeposit = await service.recordManualPayment({ id: "payment-deposit-explicit", tenancyId: "t", amountCents: 100, postedOn: "2026-09-03", paymentMethod: "cash", description: "Deposit receipt", category: "base_rent", allocations: [{ chargeTransactionId: "charge-03", amountCents: 100 }] }, context);
    assert.equal(explicitDeposit.allocations.length, 1);
    const optOut = await service.recordManualPayment({ id: "payment-opt-out", tenancyId: "t", amountCents: 100, postedOn: "2026-09-03", paymentMethod: "cash", description: "Unapplied receipt", category: "unapplied_cash", allocations: [], autoAllocate: false }, context);
    assert.equal(optOut.allocations.length, 0);
  } finally {
    await close();
  }
});

test("auto-allocation honors earlier payment and credit applications when filling the remaining oldest balance", async () => {
  const { db, service, saveCharge, close } = await setup();
  try {
    await saveCharge("charge-partial", 1000, "2026-09-01");
    await saveCharge("charge-next", 500, "2026-09-02");
    await service.recordManualPayment({ id: "payment-prior", tenancyId: "t", amountCents: 400, postedOn: "2026-09-02", paymentMethod: "cash", description: "Prior receipt", category: "base_rent", allocations: [{ chargeTransactionId: "charge-partial", amountCents: 400 }], autoAllocate: false }, context);
    await service.saveLedgerTransaction({ id: "credit", propertyId: "p", unitId: "u", tenancyId: "t", personId: "person", kind: "credit", category: "base_rent", amountCents: 100, postedOn: "2026-09-01", dueOn: null, status: "posted", description: "Imported account credit", payer: "tenant", paymentMethod: null, categoryKnowledge: "manual", amountKnowledge: "known", postedOnKnowledge: "manual", dueOnKnowledge: "unknown", statusKnowledge: "manual", descriptionKnowledge: "manual", payerKnowledge: "manual", propertyLinkKnowledge: "manual", unitLinkKnowledge: "manual", tenancyLinkKnowledge: "manual", personLinkKnowledge: "manual", chargeDefinitionId: null, chargeDefinitionLinkKnowledge: "unknown", paymentMethodKnowledge: "unknown" });
    await db.exec("RESET ROLE; CREATE ROLE rent_ops_staging_importer; GRANT USAGE ON SCHEMA public TO rent_ops_staging_importer; GRANT SELECT, INSERT ON rent_ops_ledger_transactions, rent_ops_payment_allocations TO rent_ops_staging_importer; SET ROLE rent_ops_staging_importer;");
    await db.exec(`INSERT INTO rent_ops_payment_allocations(id,payment_transaction_id,charge_transaction_id,amount_cents,allocated_on,payment_link_knowledge,charge_link_knowledge,amount_knowledge,allocated_on_knowledge,source_system,source_id,kind,source_artifact_sha256,artifact_observation_on,credit_transaction_id,credit_link_knowledge,source_property_id) VALUES('credit-application',NULL,'charge-partial',100,'2026-09-01','unknown','exact','known','source','rent_manager','credit-application','credit_allocation',repeat('a',64),'2026-09-02','credit','exact','p')`);
    await db.exec("SET ROLE qa_operations");

    const result = await service.recordManualPayment({ id: "payment-next", tenancyId: "t", amountCents: 700, postedOn: "2026-09-03", paymentMethod: "cash", description: "Current receipt", category: "base_rent", allocations: [] }, context);
    assert.deepEqual(result.allocations.map((row) => [row.chargeTransactionId, row.amountCents]), [["charge-partial", 500], ["charge-next", 200]]);
    assert.equal(result.unappliedCents, 0);
  } finally {
    await close();
  }
});

test("existing receipt auto-allocation leaves excess unapplied, skips reversed and future charges, and can resume after a new charge", async () => {
  const { service, saveCharge, close } = await setup();
  try {
    await saveCharge("charge-reversed", 500, "2026-09-01");
    await saveCharge("charge-open", 300, "2026-09-02");
    await saveCharge("charge-future-due", 200, "2026-09-02", { dueOn: "2026-09-12" });
    await saveCharge("charge-future-posted", 1000, "2026-09-10");
    await service.recordManualPayment({ id: "payment-existing", tenancyId: "t", amountCents: 1000, postedOn: "2026-09-03", paymentMethod: "check", description: "Existing receipt", category: "unapplied_cash", allocations: [], autoAllocate: false }, context);
    await service.reverseLedgerTransaction("charge-reversed", { id: "reversal-charge", postedOn: "2026-09-03", dueOn: "2026-09-03", description: "Void charge" });

    const first = await service.autoAllocatePayment("payment-existing", context);
    assert.equal(first.replayed, false);
    assert.deepEqual(first.allocations.map((row) => [row.chargeTransactionId, row.amountCents]), [["charge-open", 300]]);
    assert.equal(first.allocatedCents, 300);
    assert.equal(first.unappliedCents, 700);

    const replay = await service.autoAllocatePayment("payment-existing", context);
    assert.equal(replay.replayed, true);
    assert.equal((await service.snapshot()).paymentAllocations.filter((row) => row.paymentTransactionId === "payment-existing").length, 1);

    await saveCharge("charge-added-later", 400, "2026-09-03");
    const resumed = await service.autoAllocatePayment("payment-existing", context);
    assert.equal(resumed.replayed, false);
    assert.equal(resumed.allocations.find((row) => row.chargeTransactionId === "charge-added-later")?.amountCents, 400);
    assert.equal(resumed.unappliedCents, 300);
  } finally {
    await close();
  }
});
