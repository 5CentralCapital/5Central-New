import assert from "node:assert/strict";
import test from "node:test";

import { serializeAdminDashboard } from "../../../../server/rent-ops/presentation/dashboard";
import { buildRentOpsQuery, currentLocalIsoDate, escapeCsvCell, loadRentOpsAdminSnapshot, loadRentOpsChargeDefinitions, loadRentOpsPreviewContext, loadRentOpsReport, postRentOpsMutation, reportCell, RentOpsApiError } from "./api";
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
    scopeType: "property", scopeId: "property:one", propertyId: "property:one", chargeDefinitionId: "charge:rent", category: "base_rent", description: "Rent", amountDollars: "1200.00", effectiveFrom: "2026-09-01", active: "true", source: "must-not-leak", effectiveFromKnowledge: "unknown_open_start",
  });
  assert.match(String(root.id), /^manual:save-recurring-schedule:/);
  assert.deepEqual({ ...root, id: undefined }, { id: undefined, scopeType: "property", scopeId: "property:one", propertyId: "property:one", chargeDefinitionId: "charge:rent", category: "base_rent", description: "Rent", amountCents: 120000, effectiveFrom: "2026-09-01", active: true });
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
