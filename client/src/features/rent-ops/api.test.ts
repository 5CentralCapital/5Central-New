import assert from "node:assert/strict";
import test from "node:test";

import { serializeAdminDashboard } from "../../../../server/rent-ops/presentation/dashboard";
import { createDemoAdminSnapshot } from "./demo";
import { filterReportRows, buildRentOpsQuery, currentLocalIsoDate, escapeCsvCell, loadRentOpsAdminSnapshot, loadRentOpsChargeDefinitions, loadRentOpsPreviewContext, loadRentOpsReport, postRentOpsMutation, reportCell, RentOpsApiError } from "./api";
import type { ReportKey } from "./types";
import { parseCentsInput, requireCentsInput } from "./money";
import { mutationPayload } from "./form-payload";

test("CSV cells cannot become spreadsheet formulas", () => {
  assert.equal(escapeCsvCell("=2+2"), "'=2+2");
  assert.equal(escapeCsvCell("  @SUM(A1:A2)"), "'  @SUM(A1:A2)");
  assert.equal(escapeCsvCell("safe text"), "safe text");
});

test("live report defaults follow the current local calendar date", () => {
  assert.equal(currentLocalIsoDate(new Date(2027, 1, 3, 23, 45)), "2027-02-03");
});

test("manager preview context uses the server-provided business date", async () => {
  const restore = stubJsonResponse({ asOfDate: "2026-10-01", dataMode: "synthetic" });
  try {
    assert.deepEqual(await loadRentOpsPreviewContext(), { asOfDate: "2026-10-01", source: "synthetic" });
  } finally {
    restore();
  }
});

test("report date input errors are clear while other invalid requests stay generic", async () => {
  const reportRestore = stubJsonResponse({ code: "invalid_input" }, 400);
  try {
    await assert.rejects(loadRentOpsAdminSnapshot({ asOfDate: "2026-09-07" }), /selected report date or filters/i);
  } finally {
    reportRestore();
  }

  const mutationRestore = stubJsonResponse({ code: "invalid_input" }, 400);
  try {
    await assert.rejects(loadRentOpsChargeDefinitions(), /request contains invalid input/i);
  } finally {
    mutationRestore();
  }
});

test("money parsing rejects fractional cents instead of rounding", () => {
  assert.equal(parseCentsInput("1234.56"), 123456);
  assert.equal(parseCentsInput("1234.5"), 123450);
  assert.equal(parseCentsInput("1234.567"), undefined);
  assert.equal(parseCentsInput("-1.00"), undefined);
  assert.throws(() => requireCentsInput("1234.567", "Market rent"), /no more than two decimal places/);
});

test("report query serialization includes every supported identity and unit filter", () => {
  const query = buildRentOpsQuery({
    propertyScope: "active",
    propertyId: "property:one",
    unitId: "unit:one",
    tenancyId: "tenancy:one",
    personId: "person:one",
    asOfDate: "2026-08-16",
    month: "2026-08",
    occupancy: ["current", "vacant"],
    readiness: ["ready"],
    listing: ["listed"],
    balanceStatus: "due",
    status: ["current", "under_review"],
    search: "Smith",
  });
  const params = new URLSearchParams(query);
  assert.equal(params.get("propertyScope"), "active");
  assert.equal(params.get("propertyId"), "property:one");
  assert.equal(params.get("unitId"), "unit:one");
  assert.equal(params.get("tenancyId"), "tenancy:one");
  assert.equal(params.get("personId"), "person:one");
  assert.equal(params.get("occupancy"), "current,vacant");
  assert.equal(params.get("status"), "current,under_review");
  assert.equal(params.get("search"), "Smith");
  assert.equal(buildRentOpsQuery({ propertyId: "all", status: "all" }), "");
});

function stubJsonResponse(body: unknown, status = 200): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

const reportFixtures: Record<ReportKey, unknown> = {
  "rent-roll": {},
  occupancy: {},
  "scheduled-income": {},
  "collected-income": {},
  "scheduled-vs-collected": {},
  delinquency: {},
  "tenant-ledger": { transaction: {} },
  "lease-expiration": {},
  "security-deposit": {},
  "applicant-pipeline": {},
  hap: {},
};

test("each report endpoint uses its positive row decoder", async () => {
  for (const [report, row] of Object.entries(reportFixtures) as Array<[ReportKey, unknown]>) {
    const restore = stubJsonResponse({ report, filters: {}, rows: [row] });
    try {
      assert.equal((await loadRentOpsReport(report))[0] !== undefined, true);
    } finally {
      restore();
    }
  }
});

test("report rows reject unknown and forbidden keys before browser state", async () => {
  for (const key of ["source", "importRun", "storage", "hash", "ssn", "dob", "credential"] as const) {
    const restore = stubJsonResponse({ report: "occupancy", filters: {}, rows: [{ [key]: "canary" }] });
    try {
      await assert.rejects(loadRentOpsReport("occupancy"), /invalid response/);
    } finally {
      restore();
    }
  }
});

test("charge-definition catalog decodes only positive nullable fields", async () => {
  const restore = stubJsonResponse([{ id: "charge-definition:rent", displayName: null, displayNameKnowledge: "unknown", category: "base_rent", categoryKnowledge: "source", active: true, activeKnowledge: "source", recordRevision: 2 }]);
  try {
    assert.deepEqual(await loadRentOpsChargeDefinitions(), [{ id: "charge-definition:rent", displayName: null, displayNameKnowledge: "unknown", category: "base_rent", categoryKnowledge: "source", active: true, activeKnowledge: "source", recordRevision: 2 }]);
  } finally {
    restore();
  }
  const polluted = stubJsonResponse([{ id: "charge-definition:rent", source: "provider-row" }]);
  try {
    await assert.rejects(loadRentOpsChargeDefinitions(), /invalid response/);
  } finally {
    polluted();
  }
});

function validSnapshotRoot(): Record<string, unknown> {
  const reportRows: Record<string, unknown> = Object.fromEntries(Object.entries(reportFixtures));
  return {
    generatedAt: "2026-08-17T12:00:00.000Z",
    summary: {
      asOfDate: "2026-08-17", propertyCount: 0, unitCount: 0, occupiedUnits: 0, futurePreleasedUnits: 0,
      genuineVacantUnits: 0, readyVacantUnits: 0, notReadyUnits: 0, offMarketUnits: 0, physicalOccupancyPercent: 0,
      scheduledRentCents: 0, collectedRentCents: 0, rentOnlyDelinquencyCents: 0, totalDelinquencyCents: 0,
      unappliedCashCents: 0, expiringIn30Days: 0, expiringIn60Days: 0, expiringIn90Days: 0, monthToMonthCount: 0,
      applicationsSubmitted: 0, applicationsMissingInformation: 0, securityDepositLiabilityCents: 0, drilldowns: {},
    },
    snapshot: {
      properties: [], units: [], people: [], householdMemberships: [], tenancies: [], leaseTerms: [], recurringSchedules: [],
      ledgerTransactions: [], paymentAllocations: [], securityDeposits: [], subsidyContracts: [], applications: [],
      applicationHouseholdMembers: [], applicationRequirements: [], documents: [], activityEvents: [],
    },
    rentRoll: [], occupancy: [], scheduledIncome: [], collectedIncome: [], scheduledVsCollected: [], delinquency: [], ledger: [], leaseExpiration: [], depositLiability: [], hap: [],
    tenants: [], applicants: [], documents: [], activities: [], reports: reportRows,
  };
}

function serializedServerDocumentBundle(): Record<string, unknown> {
  const document = {
    id: "document:contract",
    propertyId: "property:contract",
    type: "lease",
    state: "verified",
    fileName: "lease.pdf",
    mimeType: "application/pdf",
    sizeBytes: 4,
    uploadedAt: "2026-08-17T12:00:00.000Z",
    verifiedAt: "2026-08-17T12:01:00.000Z",
    availability: "verified",
    storageKey: "documents/private/document:contract",
    storageKeyKnowledge: "source",
    checksumSha256: "a".repeat(64),
    source: { system: "rm", sourceId: "provider-document" },
    hash: "server-only-hash",
  };
  const emptySnapshot = {
    properties: [],
    units: [],
    people: [],
    householdMemberships: [],
    tenancies: [],
    leaseTerms: [],
    recurringSchedules: [],
    ledgerTransactions: [],
    paymentAllocations: [],
    securityDeposits: [],
    subsidyContracts: [],
    applications: [],
    applicationHouseholdMembers: [],
    applicationRequirements: [],
    documents: [document],
    activityEvents: [],
  };
  const reports = {
    "rent-roll": [],
    occupancy: [],
    "scheduled-income": [],
    "collected-income": [],
    "scheduled-vs-collected": [],
    delinquency: [],
    "tenant-ledger": [],
    "lease-expiration": [],
    "security-deposit": [],
    "applicant-pipeline": [],
    hap: [],
  };
  return JSON.parse(JSON.stringify(serializeAdminDashboard({
    generatedAt: "2026-08-17T12:02:00.000Z",
    summary: validSnapshotRoot().summary as never,
    snapshot: emptySnapshot as never,
    reports,
    tenants: [],
    applicants: [],
    documents: [document as never],
    activities: [],
  }))) as Record<string, unknown>;
}

function documentArrays(bundle: Record<string, unknown>): Array<Record<string, unknown>> {
  const snapshot = bundle.snapshot as Record<string, unknown>;
  return [
    (snapshot.documents as Array<Record<string, unknown>>)[0],
    (bundle.documents as Array<Record<string, unknown>>)[0],
  ];
}

test("server document DTO serializes through the real browser decoder without storage metadata", async () => {
  const bundle = serializedServerDocumentBundle();
  const documents = documentArrays(bundle);
  for (const document of documents) {
    assert.deepEqual(Object.keys(document).sort(), ["availability", "downloadAvailable", "fileName", "id", "mimeType", "propertyId", "sizeBytes", "state", "type", "uploadedAt", "verifiedAt"]);
    assert.equal(document.downloadAvailable, true);
    assert.equal("storageKeyKnowledge" in document, false);
    assert.equal("storageKey" in document, false);
    assert.equal("checksumSha256" in document, false);
    assert.equal("source" in document, false);
    assert.equal("hash" in document, false);
  }

  const restore = stubJsonResponse(bundle);
  try {
    const loaded = await loadRentOpsAdminSnapshot({ asOfDate: "2026-08-17" });
    assert.equal(loaded.snapshot.snapshot.documents[0].downloadAvailable, true);
    assert.equal("storageKeyKnowledge" in loaded.snapshot.snapshot.documents[0], false);
  } finally {
    restore();
  }

  for (const key of ["storageKeyKnowledge", "storageKey", "checksumSha256", "source", "hash"] as const) {
    const polluted = structuredClone(bundle);
    for (const document of documentArrays(polluted)) document[key] = "forbidden-canary";
    const restorePolluted = stubJsonResponse(polluted);
    try {
      await assert.rejects(loadRentOpsAdminSnapshot({ asOfDate: "2026-08-17" }), /invalid response/);
    } finally {
      restorePolluted();
    }
  }
});

test("snapshot root rejects unknown and forbidden fields before state is set", async () => {
  for (const [field, value] of [["unexpected", "value"], ["source", "canary"], ["importRun", "canary"], ["storage", "canary"], ["hash", "canary"], ["ssn", "canary"], ["dob", "canary"], ["credential", "canary"]] as const) {
    const body = validSnapshotRoot();
    body[field] = value;
    const restore = stubJsonResponse(body);
    try {
      await assert.rejects(loadRentOpsAdminSnapshot({ asOfDate: "2026-08-17" }), /invalid response/);
    } finally {
      restore();
    }
  }
});

test("reportCell reads DTO fields without requiring an id or an index signature", () => {
  const row = { propertyName: "Example" } as const;
  assert.equal(reportCell(row, "propertyName"), "Example");
  assert.equal(reportCell(row, "id"), undefined);
});

test("existing edits use sparse PATCH bodies and stale conflicts are explicit", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ input: url, init });
    if (url.endsWith("/api/rent-ops/auth/csrf")) return new Response(JSON.stringify({ csrfToken: "c".repeat(48) }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await postRentOpsMutation({ action: "save-property", payload: { id: "property:one", revision: 3, name: "Manual name" } });
    const patchCall = calls.at(-1)!;
    assert.equal(patchCall.input, "/api/rent-ops/properties/property%3Aone");
    assert.equal(patchCall.init?.method, "PATCH");
    assert.deepEqual(JSON.parse(String(patchCall.init?.body)), { revision: 3, name: "Manual name" });
    assert.equal(new Headers(patchCall.init?.headers).get("x-rent-ops-csrf"), "c".repeat(48));

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push({ input: url, init });
      return new Response(JSON.stringify({ code: "conflict" }), { status: 409, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    await assert.rejects(
      () => postRentOpsMutation({ action: "save-property", payload: { id: "property:one", revision: 3, name: "Stale name" } }),
      (error: unknown) => error instanceof RentOpsApiError && error.code === "conflict" && /workspace was refreshed/i.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successor mutations use predecessor path, explicit revision/date, and no end amount", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ input: url, init });
    if (url.endsWith("/api/rent-ops/auth/csrf")) return new Response(JSON.stringify({ csrfToken: "c".repeat(48) }), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await postRentOpsMutation({ action: "replace-recurring-schedule", payload: { predecessorId: "schedule:one", id: "schedule:two", expectedRevision: 3, action: "replace", effectiveFrom: "2026-09-01", amountCents: 125000 } });
    const replaceCall = calls.at(-1)!;
    assert.equal(replaceCall.input, "/api/rent-ops/recurring-schedules/schedule%3Aone/successor");
    assert.deepEqual(JSON.parse(String(replaceCall.init?.body)), { id: "schedule:two", expectedRevision: 3, action: "replace", effectiveFrom: "2026-09-01", amountCents: 125000 });
    await postRentOpsMutation({ action: "end-recurring-schedule", payload: { predecessorId: "schedule:two", id: "schedule:three", expectedRevision: 4, action: "end", effectiveFrom: "2026-10-01" } });
    const endCall = calls.at(-1)!;
    assert.deepEqual(JSON.parse(String(endCall.init?.body)), { id: "schedule:three", expectedRevision: 4, action: "end", effectiveFrom: "2026-10-01" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("client refuses native HAP creation before issuing a request", async () => {
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { requests += 1; return new Response("{}", { status: 500 }); }) as typeof fetch;
  try {
    await assert.rejects(
      () => postRentOpsMutation({ action: "save-subsidy-contract", payload: { id: "native-hap", propertyId: "property:1" } }),
      (error: unknown) => error instanceof RentOpsApiError && error.code === "hap_create_requires_provenance",
    );
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incomplete imported edit forms emit only the changed field and preserve unknown checkboxes", () => {
  assert.deepEqual(
    mutationPayload("save-property", { id: "property:1", revision: 2, name: "Operator name" }, { id: "property:1", revision: 2, name: "Imported name" }),
    { id: "property:1", name: "Operator name", revision: 2 },
  );
  assert.deepEqual(
    mutationPayload("save-person", { id: "person:1", revision: 2, firstName: "Updated", archived: false }, { id: "person:1", revision: 2, firstName: "Imported" }),
    { id: "person:1", firstName: "Updated", revision: 2 },
  );
  assert.deepEqual(
    mutationPayload("save-lease-term", { id: "lease:1", revision: 2, status: "executed", contractStartOn: "2026-01-01", monthToMonth: false }, { id: "lease:1", revision: 2, status: "executed", contractStartOn: "2026-01-01" }),
    { id: "lease:1", revision: 2 },
  );
  assert.deepEqual(
    mutationPayload("save-security-deposit", { id: "deposit:1", revision: 2, receivedOn: "" }, { id: "deposit:1", revision: 2, receivedOn: "2026-01-01" }),
    { id: "deposit:1", receivedOn: null, revision: 2 },
  );
  assert.deepEqual(
    mutationPayload(
      "save-subsidy-contract",
      { id: "hap:1", revision: 4, propertyId: "property:1", unitId: "unit:1", tenancyId: "tenancy:1", agencyName: "Imported HAP", contractNumber: "HAP-1", effectiveFrom: "2026-01-01", effectiveTo: "", agencyDollars: "900", tenantDollars: "100", status: "ended" },
      { id: "hap:1", revision: 4, propertyId: "property:1", unitId: "unit:1", tenancyId: "tenancy:1", agencyName: "Imported HAP", contractNumber: "HAP-1", effectiveFrom: "2026-01-01", effectiveTo: "", agencyDollars: "900", tenantDollars: "100", status: "active" },
    ),
    { id: "hap:1", revision: 4, status: "ended" },
  );
});

test("manual recurring and conversion payloads require positive explicit facts", () => {
  const root = mutationPayload("save-recurring-schedule", {
    scopeType: "property", scopeId: "property:one", propertyId: "property:one", chargeDefinitionId: "charge:rent", category: "base_rent", description: "Rent", amountDollars: "1200.00", billingFrequency: "monthly", effectiveFrom: "2026-09-01", active: "true", source: "must-not-leak", effectiveFromKnowledge: "unknown_open_start",
  });
  assert.match(String(root.id), /^manual:save-recurring-schedule:/);
  assert.deepEqual({ ...root, id: undefined }, { id: undefined, scopeType: "property", scopeId: "property:one", propertyId: "property:one", chargeDefinitionId: "charge:rent", category: "base_rent", description: "Rent", amountCents: 120000, billingFrequency: "monthly", effectiveFrom: "2026-09-01", active: true });
  const end = mutationPayload("end-recurring-schedule", { predecessorId: "schedule:one", expectedRevision: 2, effectiveFrom: "2026-09-01", amountDollars: "10.00" });
  assert.equal("amountCents" in end, false);
});

test("deposit browser decoders preserve null held, known zero, and signed source balances", async () => {
  const bundle = serializedServerDocumentBundle();
  (bundle.snapshot as Record<string, unknown>).securityDeposits = [
    { id: "deposit:unknown", amountHeldCents: null, sourceBalanceCents: -155000 },
    { id: "deposit:zero", amountHeldCents: 0, sourceBalanceCents: 0 },
  ];
  (bundle.summary as Record<string, unknown>).securityDepositLiabilityCents = null;
  const restore = stubJsonResponse(bundle);
  try {
    const loaded = await loadRentOpsAdminSnapshot();
    assert.equal(loaded.snapshot.snapshot.securityDeposits[0].amountHeldCents, null);
    assert.equal(loaded.snapshot.snapshot.securityDeposits[0].sourceBalanceCents, -155000);
    assert.equal(loaded.snapshot.snapshot.securityDeposits[1].amountHeldCents, 0);
    assert.equal(loaded.snapshot.summary.securityDepositLiabilityCents, null);
  } finally { restore(); }
  const restoreReport = stubJsonResponse({ report: "security-deposit", filters: {}, rows: [{ totalHeldCents: null, securityHeldCents: null, refundablePetHeldCents: 0, otherRefundableHeldCents: 0, sourceBalanceCents: -155000, unknownHeldCount: 1 }] });
  try {
    const [row] = await loadRentOpsReport("security-deposit");
    assert.equal(reportCell(row, "totalHeldCents"), null);
    assert.equal(reportCell(row, "sourceBalanceCents"), -155000);
    assert.equal(reportCell(row, "refundablePetHeldCents"), 0);
  } finally { restoreReport(); }
});

test("property filter uses ledger property identity even when its name is not a displayed column", () => {
  const snapshot = createDemoAdminSnapshot();
  const property = snapshot.snapshot.properties[0];
  const report = { ...snapshot.reports["tenant-ledger"], rows: [{ transaction: { id: "ledger:test", propertyId: property.id, description: "Payment" } }] };
  assert.equal(filterReportRows(report, { propertyId: property.id!, status: "all", search: "" }, snapshot).rows.length, 1);
});

test("unit configuration payload converts dimensions, deposit and amenities without filling unknowns", () => {
  const payload = mutationPayload("save-unit", { id: "unit:qa", propertyId: "property:qa", unitNumber: "1", bedrooms: "", bathrooms: "", squareFeet: "850", defaultDepositDollars: "1200.50", amenitiesText: "Parking\nPatio", unitType: "Apartment", accessNotes: "Front entrance" });
  assert.equal(payload.squareFeet, 850);
  assert.equal(payload.defaultDepositCents, 120050);
  assert.deepEqual(payload.amenities, ["Parking", "Patio"]);
  assert.equal("bedrooms" in payload, false);
  const unchanged = mutationPayload("save-unit", { id: "unit:qa", revision: 2, bedrooms: "", bathrooms: "", squareFeet: "", defaultDepositDollars: "", amenitiesText: "" }, { id: "unit:qa", revision: 2, bedrooms: "", bathrooms: "", squareFeet: "", defaultDepositDollars: "", amenitiesText: "" });
  assert.equal("squareFeet" in unchanged, false);
  assert.equal("defaultDepositCents" in unchanged, false);
  assert.equal("amenities" in unchanged, false);
});

test("recurring replacement confirms monthly cadence only when explicitly selected", () => {
  const values = { predecessorId: "schedule:one", expectedRevision: 2, effectiveFrom: "2026-10-01", amountDollars: "1200" };
  assert.equal("billingFrequency" in mutationPayload("replace-recurring-schedule", values), false);
  assert.equal(mutationPayload("replace-recurring-schedule", { ...values, billingFrequency: "monthly" }).billingFrequency, "monthly");
});

test("recurring DTO accepts opaque charge catalog target but rejects raw source keys", async () => {
  const bundle = serializedServerDocumentBundle();
  const snapshot = bundle.snapshot as Record<string, unknown>;
  snapshot.recurringSchedules = [{ id: "schedule:qa", chargeDefinitionId: "definition:qa", billingFrequency: "monthly" }];
  let restore = stubJsonResponse(bundle);
  try { assert.equal((await loadRentOpsAdminSnapshot()).snapshot.snapshot.recurringSchedules[0].chargeDefinitionId, "definition:qa"); }
  finally { restore(); }
  snapshot.recurringSchedules = [{ id: "schedule:qa", chargeDefinitionId: "definition:qa", sourceDefinitionId: "raw-rm-key" }];
  restore = stubJsonResponse(bundle);
  try { await assert.rejects(loadRentOpsAdminSnapshot(), /invalid response/); }
  finally { restore(); }
});

function compactSnapshotWire(legacy: Record<string, unknown>): Record<string, unknown> {
  return { transportVersion: 1, ...Object.fromEntries(["generatedAt", "summary", "snapshot", "reports", "tenants", "applicants"].map(key => [key, legacy[key]])) };
}

test("compact snapshot decodes to the same complete manager view as legacy positive DTO", async () => {
  const legacy = serializedServerDocumentBundle();
  const reports = legacy.reports as Record<string, unknown[]>;
  const rentRoll = [{ propertyId: "property:contract", propertyName: "Example", unitId: "unit:1", unitNumber: "1", baseRentCents: 100000 }];
  const ledger = [{ transaction: { id: "charge:1", propertyId: "property:contract", kind: "charge", category: "base_rent", status: "posted", amountCents: 100000, postedOn: "2026-08-01" }, runningBalanceCents: 100000 }];
  reports["rent-roll"] = rentRoll; legacy.rentRoll = rentRoll;
  reports["tenant-ledger"] = ledger; legacy.ledger = ledger;
  const activities = [{ id: "activity:1", type: "note", summary: "Review", occurredAt: "2026-08-17T12:00:00.000Z" }];
  (legacy.snapshot as Record<string, unknown>).activityEvents = activities; legacy.activities = activities;
  let restore = stubJsonResponse(legacy);
  let original: Awaited<ReturnType<typeof loadRentOpsAdminSnapshot>>;
  try { original = await loadRentOpsAdminSnapshot(); } finally { restore(); }
  restore = stubJsonResponse(compactSnapshotWire(legacy));
  try {
    const compact = await loadRentOpsAdminSnapshot();
    assert.deepEqual(compact, original);
    assert.strictEqual(compact.snapshot.rentRoll, compact.snapshot.reports["rent-roll"].rows);
    assert.strictEqual(compact.snapshot.ledger, compact.snapshot.reports["tenant-ledger"].rows);
    assert.strictEqual(compact.snapshot.documents, compact.snapshot.snapshot.documents);
    assert.strictEqual(compact.snapshot.activities, compact.snapshot.snapshot.activityEvents);
  } finally { restore(); }
});

test("compact snapshot rejects unknown versions, duplicate aliases and missing reports", async () => {
  const compact = compactSnapshotWire(serializedServerDocumentBundle());
  for (const value of [{ ...compact, transportVersion: 2 }, { ...compact, ledger: [] }, { ...compact, reports: {} }, { ...compact, sourceId: "raw" }]) {
    const restore = stubJsonResponse(value);
    try { await assert.rejects(loadRentOpsAdminSnapshot(), /invalid response/); } finally { restore(); }
  }
});

test("snapshot validation remains fresh after successful and rejected responses", async () => {
  const body = compactSnapshotWire(serializedServerDocumentBundle());
  const originalFetch = globalThis.fetch;
  // Deliberately reuse the same objects: a completed response must never leave
  // a trusted-object cache that could hide a later change to its fields.
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body })) as typeof fetch;
  try {
    const expected = await loadRentOpsAdminSnapshot();
    const snapshot = body.snapshot as Record<string, unknown>;
    const document = (snapshot.documents as Array<Record<string, unknown>>)[0];
    for (const [key, value] of [["source", "private-canary"], ["unexpected", "unknown-field"], ["sizeBytes", "invalid-number"]] as const) {
      const previous = document[key];
      document[key] = value;
      await assert.rejects(loadRentOpsAdminSnapshot(), /invalid response/);
      if (previous === undefined) delete document[key]; else document[key] = previous;
      assert.deepEqual(await loadRentOpsAdminSnapshot(), expected);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("actual recurring serializer preserves null imported cadence and links in compact snapshot and tenant profiles", async () => {
  const { serializeAdminRecurringSchedule } = await import("../../../../server/rent-ops/presentation/entities");
  const imported = serializeAdminRecurringSchedule({ id: "schedule:unknown", billingFrequency: null, chargeDefinitionId: null, amountCents: null, effectiveFrom: null, effectiveFromKnowledge: "unknown_open_start", sourceConfidence: "exception" } as never);
  const confirmed = serializeAdminRecurringSchedule({ id: "schedule:confirmed", billingFrequency: "monthly", chargeDefinitionId: "definition:rent", amountCents: 120000, effectiveFrom: "2026-09-01", active: true } as never);
  const legacy = serializedServerDocumentBundle();
  (legacy.snapshot as Record<string, unknown>).recurringSchedules = [imported, confirmed];
  legacy.tenants = [{ person: { id: "person:qa" }, household: [], tenancies: [], leaseTerms: [], schedules: [imported, confirmed], ledger: [], deposits: [], subsidyContracts: [], documents: [], activity: [] }];
  const scheduledRows = [{ scheduleId: "schedule:unknown", category: null, amountCents: null, effectiveFromKnowledge: "unknown_open_start", temporalUncertainty: true, known: false, uncertain: true, unclassified: true }];
  (legacy.reports as Record<string, unknown>)["scheduled-income"] = scheduledRows;
  legacy.scheduledIncome = scheduledRows;
  const restore = stubJsonResponse(compactSnapshotWire(legacy));
  try {
    const result = (await loadRentOpsAdminSnapshot()).snapshot;
    for (const rows of [result.snapshot.recurringSchedules, result.tenants[0].schedules]) {
      assert.equal(rows[0].billingFrequency, null);
      assert.equal(rows[0].chargeDefinitionId, null);
      assert.equal(rows[0].amountCents, null);
      assert.equal(rows[1].billingFrequency, "monthly");
      assert.equal(rows[1].chargeDefinitionId, "definition:rent");
    }
    assert.equal(result.scheduledIncome[0].uncertain, true);
    assert.equal(result.scheduledIncome[0].amountCents, null);
  } finally { restore(); }
});

test("nullable cadence contract still rejects unsupported frequency and invalid target ids", async () => {
  for (const invalid of [{ billingFrequency: "weekly" }, { billingFrequency: 1 }, { chargeDefinitionId: "invalid target with spaces" }]) {
    const legacy = serializedServerDocumentBundle();
    (legacy.snapshot as Record<string, unknown>).recurringSchedules = [{ id: "schedule:qa", ...invalid }];
    const restore = stubJsonResponse(compactSnapshotWire(legacy));
    try { await assert.rejects(loadRentOpsAdminSnapshot(), /invalid response/); } finally { restore(); }
  }
});

test("actual payment allocation DTO preserves supported kinds and signed amounts", async () => {
  const { serializeAdminPaymentAllocation } = await import("../../../../server/rent-ops/presentation/entities");
  const kinds = ["allocation", "reversal", "transfer", "credit_allocation"] as const;
  const allocations = kinds.map((kind, index) => serializeAdminPaymentAllocation({ id: `allocation:${index}`, kind, amountCents: kind === "reversal" ? -12345 : 12345, allocatedOn: "2026-09-01" } as never));
  allocations.push(serializeAdminPaymentAllocation({ id: "allocation:unknown" } as never));
  const legacy = serializedServerDocumentBundle();
  (legacy.snapshot as Record<string, unknown>).paymentAllocations = allocations;
  const restore = stubJsonResponse(compactSnapshotWire(legacy));
  try {
    const rows = (await loadRentOpsAdminSnapshot()).snapshot.snapshot.paymentAllocations;
    assert.deepEqual(rows.slice(0,4).map(row => row.kind), kinds);
    assert.deepEqual(rows.slice(0,4).map(row => row.amountCents), [12345,-12345,12345,12345]);
    assert.equal(rows[4].kind, undefined);
    assert.equal(rows[4].amountCents, undefined);
  } finally { restore(); }
  (legacy.snapshot as Record<string, unknown>).paymentAllocations = [{ id: "allocation:invalid", kind: "unsupported" }];
  const restoreInvalid = stubJsonResponse(compactSnapshotWire(legacy));
  try { await assert.rejects(loadRentOpsAdminSnapshot(), /invalid response/); } finally { restoreInvalid(); }
});

test("financial completeness contract preserves unknown balances across dashboard reports and tenant ledger", async () => {
  const legacy = serializedServerDocumentBundle();
  const unknown = { balanceComplete: false, balanceUncertaintyCodes: ["imported_history_unavailable"] };
  Object.assign(legacy.summary as object, unknown, { balanceUnresolvedCount: 1, operationalDelinquencyCents: null, operationalBalanceUnresolvedCount: 1, rentOnlyDelinquencyCents: null, totalDelinquencyCents: null, unappliedCashCents: null });
  const reportMap = legacy.reports as Record<string, unknown>;
  reportMap["rent-roll"] = [{ ...unknown, unitId: "unit:unknown", balanceDueCents: null, operationalBalanceCents: null }, { balanceComplete: true, balanceUncertaintyCodes: [], unitId: "unit:known", balanceDueCents: 0, operationalBalanceCents: 12500 }];
  reportMap.delinquency = [{ ...unknown, personId: "person:unknown", rentOnlyBalanceCents: null, nonRentBalanceCents: null, grossBalanceCents: null, totalBalanceCents: null, netAccountBalanceCents: null, unappliedCashCents: null, prepaidCents: null }];
  const ledger = [{ ...unknown, transaction: { id: "transaction:unknown", kind: "charge" }, allocatedCents: null, openCents: null, runningBalanceCents: null, openingBalanceCents: null }];
  reportMap["tenant-ledger"] = ledger;
  legacy.tenants = [{ person: { id: "person:unknown" }, household: [], tenancies: [], leaseTerms: [], schedules: [], ledger, deposits: [], subsidyContracts: [], documents: [], activity: [] }];
  const restore = stubJsonResponse(compactSnapshotWire(legacy));
  try {
    const result = (await loadRentOpsAdminSnapshot()).snapshot;
    assert.equal(result.summary.rentOnlyDelinquencyCents, null);
    assert.equal(result.summary.balanceComplete, false);
    assert.equal(result.summary.balanceUnresolvedCount, 1);
    assert.equal(result.summary.operationalDelinquencyCents, null);
    assert.equal(result.summary.operationalBalanceUnresolvedCount, 1);
    assert.equal(result.rentRoll[0].operationalBalanceCents, null);
    assert.equal(result.rentRoll[1].operationalBalanceCents, 12500);
    assert.equal(result.rentRoll[0].balanceDueCents, null);
    assert.equal(result.rentRoll[1].balanceDueCents, 0);
    assert.equal(result.delinquency[0].netAccountBalanceCents, null);
    assert.deepEqual(result.delinquency[0].balanceUncertaintyCodes, unknown.balanceUncertaintyCodes);
    for (const row of [result.ledger[0], result.tenants[0].ledger[0]]) {
      assert.equal(row.openCents, null);
      assert.equal(row.runningBalanceCents, null);
      assert.equal(row.openingBalanceCents, null);
      assert.equal(row.transaction.amountCents, undefined);
      assert.equal(row.transaction.postedOn, undefined);
    }
  } finally { restore(); }
});

test("tenant payer review uncertainty survives serializer and strict browser decoder", async () => {
  const { serializeAdminTenantProfile } = await import("../../../../server/rent-ops/presentation/entities");
  for (const unverified of [true, false]) {
    const legacy = serializedServerDocumentBundle();
    legacy.tenants = [serializeAdminTenantProfile({ person: { id: "payer-review" }, payerResponsibilityUnverified: unverified, household: [], tenancies: [], leaseTerms: [], schedules: [], ledger: [], deposits: [], subsidyContracts: [], documents: [], activity: [] })];
    const restore = stubJsonResponse(compactSnapshotWire(legacy));
    try {
      assert.equal((await loadRentOpsAdminSnapshot()).snapshot.tenants[0].payerResponsibilityUnverified, unverified);
    } finally { restore(); }
  }
});
