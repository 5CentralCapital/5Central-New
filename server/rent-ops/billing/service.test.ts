import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ensureRentOpsSchema } from "../persistence";
import { PostgresRentOpsRepository } from "../repositories/postgres";
import { presentTenantHome } from "../tenant-portal/presentation";
import { emptyRentOpsSnapshot, type RentOpsSnapshot } from "../../../shared/rent-ops-contracts";
import { RecurringBillingService, previewRecurringBilling, type BillingData, type BillingStore } from "./service";

function snapshotWithUnit(propertyId = "p1", unitId = "u1"): RentOpsSnapshot {
  const snapshot = emptyRentOpsSnapshot();
  snapshot.modelVersion = 3;
  snapshot.properties.push({ id: propertyId, name: `Property ${propertyId}`, slug: propertyId, address: { line1: "1 Main", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: "active" });
  snapshot.units.push({ id: unitId, propertyId, unitNumber: unitId, readiness: "ready", listing: "listed", propertyLinkKnowledge: "exact" });
  return snapshot;
}

function addLeaseBackedTenancy(snapshot: RentOpsSnapshot, input: { propertyId?: string; unitId?: string; personId?: string; tenancyId?: string; status?: "current" | "future" | "notice" | "past"; actualMoveInOn?: string; plannedMoveInOn?: string; actualMoveOutOn?: string }): void {
  const propertyId = input.propertyId ?? "p1";
  const unitId = input.unitId ?? "u1";
  const personId = input.personId ?? `person-${unitId}`;
  const tenancyId = input.tenancyId ?? `tenancy-${unitId}`;
  snapshot.people.push({ id: personId, firstName: "Synthetic", lastName: personId });
  const tenancy = { id: tenancyId, propertyId, unitId, primaryPersonId: personId, status: input.status ?? "current", createdAt: "2025-01-01T00:00:00.000Z" } as any;
  if (input.actualMoveInOn !== undefined) tenancy.actualMoveInOn = input.actualMoveInOn;
  else if ((input.status ?? "current") !== "future") tenancy.actualMoveInOn = "2025-01-01";
  if (input.plannedMoveInOn !== undefined) tenancy.plannedMoveInOn = input.plannedMoveInOn;
  if (input.actualMoveOutOn !== undefined) tenancy.actualMoveOutOn = input.actualMoveOutOn;
  tenancy.propertyLinkKnowledge = "exact";
  tenancy.unitLinkKnowledge = "exact";
  tenancy.primaryPersonLinkKnowledge = "exact";
  tenancy.statusKnowledge = "source";
  tenancy.actualMoveInKnowledge = tenancy.actualMoveInOn ? "source" : "unknown";
  tenancy.plannedMoveInKnowledge = tenancy.plannedMoveInOn ? "source" : "unknown";
  tenancy.actualMoveOutKnowledge = tenancy.actualMoveOutOn ? "source" : "unknown";
  snapshot.tenancies.push(tenancy);
  snapshot.leaseTerms.push({ id: `lease-${tenancyId}`, tenancyId, tenancyLinkKnowledge: "exact", status: "executed", statusKnowledge: "source", contractStartOn: "2025-01-01", contractStartKnowledge: "source", contractEndOn: "2026-12-31", contractEndKnowledge: "source", monthToMonth: false, monthToMonthKnowledge: "source", createdAt: "2025-01-01T00:00:00.000Z" });
}

function schedule(input: Record<string, unknown>): RentOpsSnapshot["recurringSchedules"][number] {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(input, key);
  const scopeType = (has("scopeType") ? input.scopeType : undefined) as "tenant" | "unit" | "property" | null | undefined;
  const propertyId = (has("propertyId") ? input.propertyId : "p1") as string | null;
  const unitId = (has("unitId") ? input.unitId : null) as string | null;
  const personId = (has("personId") ? input.personId : null) as string | null;
  const defaultScopeId = scopeType === "unit" && typeof unitId === "string"
    ? unitId
    : scopeType === "tenant" && typeof personId === "string"
      ? personId
      : scopeType === "property" && typeof propertyId === "string"
        ? propertyId
        : null;
  const category = has("category") ? input.category : "base_rent";
  const amountCents = has("amountCents") ? input.amountCents : 1000;
  const effectiveFrom = has("effectiveFrom") ? input.effectiveFrom : "2025-01-01";
  const active = has("active") ? input.active : true;
  const chargeDefinitionId = has("chargeDefinitionId") ? input.chargeDefinitionId : null;
  return {
    billingFrequency: (has("billingFrequency") ? input.billingFrequency : "monthly") as "monthly" | null,
    id: String(input.id),
    source: undefined,
    propertyId,
    scopeType,
    scopeId: (has("scopeId") ? input.scopeId : defaultScopeId) as string | null | undefined,
    scopeLinkKnowledge: (has("scopeLinkKnowledge") ? input.scopeLinkKnowledge : "exact") as any,
    scopeTypeKnowledge: (has("scopeTypeKnowledge") ? input.scopeTypeKnowledge : "source") as any,
    tenancyId: (has("tenancyId") ? input.tenancyId : null) as string | null,
    personId,
    unitId,
    category: category as never,
    categoryKnowledge: (has("categoryKnowledge") ? input.categoryKnowledge : category === null ? "unknown" : "source") as any,
    amountCents: amountCents as never,
    amountKnowledge: (has("amountKnowledge") ? input.amountKnowledge : amountCents === null ? "unknown" : "known") as any,
    effectiveFrom: effectiveFrom as any,
    effectiveFromKnowledge: (has("effectiveFromKnowledge") ? input.effectiveFromKnowledge : "manual") as any,
    active: active as boolean | null,
    activeKnowledge: (has("activeKnowledge") ? input.activeKnowledge : "source") as any,
    chargeDefinitionId: chargeDefinitionId as string | null,
    chargeDefinitionLinkKnowledge: (has("chargeDefinitionLinkKnowledge") ? input.chargeDefinitionLinkKnowledge : chargeDefinitionId ? "exact" : "unknown") as any,
    chargeDefinitionKey: (has("chargeDefinitionKey") ? input.chargeDefinitionKey : null) as string | null,
    description: has("description") ? input.description as string | null : "synthetic",
    descriptionKnowledge: (has("descriptionKnowledge") ? input.descriptionKnowledge : "source") as any,
    sourceArtifactSha256: has("sourceArtifactSha256") ? input.sourceArtifactSha256 as string | null : null,
    artifactObservationOn: has("artifactObservationOn") ? input.artifactObservationOn as any : null,
    lineageRootId: String(input.lineageRootId ?? input.id),
    lineageRootOrigin: "manual",
    versionOrigin: "manual",
    versionAction: "root",
  } as any;
}


function fixture(): BillingData {
  const snapshot = snapshotWithUnit();
  addLeaseBackedTenancy(snapshot, {});
  snapshot.recurringSchedules.push(schedule({id: "rent", scopeType: "tenant", tenancyId: "tenancy-u1", personId: "person-u1", unitId: "u1", chargeDefinitionId: "def-rent", amountCents: 125000}));
  return {snapshot, receipts: []};
}
function memoryStore(initial: BillingData, failAt = 0) {
  let data = structuredClone(initial);
  let queue: Promise<unknown> = Promise.resolve();
  const store: BillingStore = {
    async read() { return structuredClone(data); },
    transaction(_month, work) {
      const next = queue.then(async () => {
        const draft = structuredClone(data);
        let inserts = 0;
        const result = await work({read: async () => structuredClone(draft), insert: async (entry, receipt) => {
          if (++inserts === failAt) throw new Error("simulated write failure");
          assert.ok(!draft.receipts.some(r => r.lineageRootId === receipt.lineageRootId && r.billingOn === receipt.billingOn));
          draft.snapshot.ledgerTransactions.push(entry); draft.receipts.push(receipt);
        }});
        data = draft; return result;
      });
      queue = next.catch(() => {}); return next;
    },
  };
  return store;
}

test("preview is read-only; explicit post and replay create exactly one charge", async () => {
  const store = memoryStore(fixture()); const service = new RecurringBillingService(store);
  const preview = await service.preview("2025-05");
  assert.equal(preview.readyCount, 1); assert.equal(preview.readyCents, 125000);
  assert.equal((await store.read("2025-05")).snapshot.ledgerTransactions.length, 0);
  const input = {month: "2025-05", previewToken: preview.previewToken, actorSubject: "admin"};
  const results = await Promise.all([service.post(input), service.post(input)]);
  assert.equal(results.reduce((n, r) => n + r.postedCount, 0), 1);
  assert.equal(results[1].alreadyPostedCount, 1);
  assert.equal((await store.read("2025-05")).receipts.length, 1);
  assert.equal((await service.preview("2025-05")).postedCount, 1);
  assert.equal((await service.preview("2025-06")).readyCount, 1);
});

test("unknown amounts, partial months, and existing manual charges block posting", () => {
  for (const mutate of [
    (data: BillingData) => { data.snapshot.recurringSchedules[0].amountKnowledge = "unknown"; },
    (data: BillingData) => { data.snapshot.recurringSchedules[0].active = null; data.snapshot.recurringSchedules[0].activeKnowledge = "unknown"; },
    (data: BillingData) => { data.snapshot.recurringSchedules[0].effectiveFrom = null; data.snapshot.recurringSchedules[0].effectiveFromKnowledge = "unknown_open_start"; },
    (data: BillingData) => { data.snapshot.recurringSchedules[0].effectiveFrom = "2025-05-15"; },
    (data: BillingData) => { data.snapshot.tenancies[0].actualMoveInOn = "2025-05-15"; },
    (data: BillingData) => { data.snapshot.ledgerTransactions.push({id: "manual", tenancyId: "tenancy-u1", kind: "charge", status: "posted", category: "base_rent", amountCents: 125000, postedOn: "2025-05-01"}); },
  ]) {
    const data = fixture(); mutate(data); const preview = previewRecurringBilling(data, "2025-05");
    assert.equal(preview.readyCount, 0); assert.ok(preview.blockedCount > 0);
  }
});

test("inactive schedules do not bill; subsidy and deposits use separate workflows", () => {
  const data = fixture(); data.snapshot.recurringSchedules[0].active = false;
  assert.equal(previewRecurringBilling(data, "2025-05").readyCount, 0);
  for (const category of ["subsidy", "deposit"] as const) {
    const data = fixture(); data.snapshot.recurringSchedules[0].category = category as any;
    assert.equal(previewRecurringBilling(data, "2025-05").readyCount, 0);
  }
});

test("stale preview cannot post and write failure rolls back whole batch", async () => {
  const data = fixture(); const preview = previewRecurringBilling(data, "2025-05");
  data.snapshot.recurringSchedules[0].amountCents = 130000;
  await assert.rejects(new RecurringBillingService(memoryStore(data)).post({month: "2025-05", previewToken: preview.previewToken, actorSubject: "admin"}), /preview_changed/);
  const store = memoryStore(fixture(), 1); const service = new RecurringBillingService(store);
  await assert.rejects(service.post({month: "2025-05", previewToken: preview.previewToken, actorSubject: "admin"}), /simulated/);
  assert.equal((await store.read("2025-05")).snapshot.ledgerTransactions.length, 0);
});


test("native billing ledger survives actual SQL and model3 mapping with complete tenant balance", async () => {
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({apply:true, executor: async sql => { await db.exec(sql); }});
    await db.exec(`INSERT INTO rent_ops_properties (id,name,slug,address_line1,city,state,postal_code,property_type) VALUES ('p1','Synthetic','synthetic','1 Main','Town','FL','00000','multifamily');
      INSERT INTO rent_ops_units (id,property_id,unit_number,property_link_knowledge) VALUES ('u1','p1','1','manual');
      INSERT INTO rent_ops_people(id,first_name,last_name) VALUES ('person-u1','Synthetic','Resident');
      INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge) VALUES ('tenancy-u1','p1','u1','person-u1','current',NOW(),'manual','manual','manual','manual');
      INSERT INTO rent_ops_charge_definitions(id,category,category_knowledge,display_name,display_name_knowledge,active,active_knowledge) VALUES ('def-rent','base_rent','manual','Rent','manual',true,'manual');`);
    // SQL data is real; privilege isolation has its own full-role integration test.
    const executor = {query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("has_table_privilege")) return {rows:(values![0] as string[]).map(table_name => ({table_name,can_select:false,can_insert:false,can_update:false,can_delete:false}))};
      return db.query(sql, values);
    }};
    const repository = new PostgresRentOpsRepository(executor as any);
    const store = memoryStore(fixture()); const service = new RecurringBillingService(store);
    const preview = await service.preview("2025-05");
    await service.post({month:"2025-05",previewToken:preview.previewToken,actorSubject:"admin"});
    const generated = (await store.read("2025-05")).snapshot.ledgerTransactions[0];
    await repository.saveLedgerTransaction(generated);
    const snapshot = await repository.getSnapshot();
    assert.equal(snapshot.modelVersion,3);
    const home = presentTenantHome(snapshot,{id:"a", email:"resident@example.test", personId:"person-u1",tenancyId:"tenancy-u1",status:"active"},"2025-05-31");
    assert.equal(home?.balance.complete,true); assert.equal(home?.balance.amountCents,125000);
  } finally { await db.close(); }
});

test("billing selection validates identity and binds preview and replay to exact scope", async () => {
  const data = fixture();
  const service = new RecurringBillingService(memoryStore(data));
  for (const scope of [{}, { propertyId: "missing" }, { tenancyId: "missing" }, { propertyId: "other", tenancyId: "tenancy-u1" }]) {
    await assert.rejects(service.preview("2025-05", scope), /invalid_input/);
  }
  const global = await service.preview("2025-05");
  const scope = { tenancyId: "tenancy-u1" };
  const selected = await service.preview("2025-05", scope);
  assert.equal(selected.readyCount, 1);
  assert.notEqual(global.previewToken, selected.previewToken);
  await assert.rejects(service.post({ month: "2025-05", previewToken: selected.previewToken, actorSubject: "admin" }), /preview_changed/);
  const result = await service.post({ month: "2025-05", previewToken: selected.previewToken, actorSubject: "admin", scope });
  assert.equal(result.postedCount, 1);
  assert.equal((await service.post({ month: "2025-05", previewToken: selected.previewToken, actorSubject: "admin", scope })).alreadyPostedCount, 1);
  await assert.rejects(service.post({ month: "2025-05", previewToken: selected.previewToken, actorSubject: "admin" }), /preview_changed/);
});

test("unknown cadence blocks billing until an explicit monthly successor is configured", () => {
 const data=fixture();const original=data.snapshot.recurringSchedules[0];original.billingFrequency=null;original.effectiveFromKnowledge="source";original.lineageRootOrigin="artifact";original.versionOrigin="artifact";original.source={system:"rm",sourceId:"source-rent"};original.sourceArtifactSha256="a".repeat(64);original.artifactObservationOn="2025-01-01";
 assert.equal(previewRecurringBilling(data,"2025-05").readyCount,0);
 assert.ok(previewRecurringBilling(data,"2025-05").rows.some(row=>row.reasons.some(reason=>reason.includes("frequency"))));
 data.snapshot.recurringSchedules.push({...original,id:"confirmed-monthly",billingFrequency:"monthly",versionOrigin:"manual",versionAction:"replace",supersedesId:original.id,lineageRootId:original.lineageRootId??original.id,effectiveFrom:"2025-05-01",effectiveFromKnowledge:"manual",recordRevision:2,source:undefined});
 assert.equal(previewRecurringBilling(data,"2025-05").readyCount,1);
 assert.equal(original.billingFrequency,null);
});
