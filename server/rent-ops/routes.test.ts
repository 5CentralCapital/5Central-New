import assert from "node:assert/strict";
import http from "node:http";
import test, { beforeEach } from "node:test";
import express from "express";
import type { RentManagerRawRecord } from "../../../shared/rent-ops-contracts";
import { createSyntheticRentOpsRepository, syntheticRentOpsSnapshot } from "./fixtures/synthetic";
import { projectRentManagerApplicationHistory } from "./application-history/projection";
import { SyntheticRentOpsRepository } from "./repositories/synthetic";
import { registerRentOpsRoutes } from "./routes";
import { createInMemoryObjectStore } from "./storage";

// The synthetic occupancy and ledger describe August 2026. Keep default-date
// route coverage on that date; elapsed move-ins are tested explicitly below.
beforeEach((context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-16T12:00:00.000Z") });
});

const body = {
  email: "route.applicant@example.test",
  firstName: "Route",
  lastName: "Applicant",
  phone: "+1-555-0188",
  currentAddress: "88 Example Street",
};

const forbiddenKeys = new Set([
  "source", "sourceId", "sourceSystem", "sourceUpdatedAt", "sourceRecord", "sourceRecords", "importRuns", "importRecord", "importRecords", "import", "manifest", "checkpoint", "resume", "token", "hash", "digest", "raw", "rawPayload", "restricted", "restrictedPayload", "payload", "storage", "storageKey", "checksum", "checksumSha256", "backend", "bucket", "key", "generation", "version", "signedUrl", "downloadUrl", "provenance", "sourceDefinitionId", "sourceDefinitionKey", "chargeDefinitionKey",
]);

const canaryFields = {
  id: "canary-source-record",
  source: { sourceId: "provider-id", sourceSystem: "rm", sourceUpdatedAt: "2026-08-17T00:00:00.000Z" },
  sourceId: "provider-id",
  sourceSystem: "rm",
  sourceUpdatedAt: "2026-08-17T00:00:00.000Z",
  importRuns: [{ manifest: "secret", checkpoint: "secret", resume: "secret" }],
  token: "secret-token",
  hash: "secret-hash",
  digest: "secret-digest",
  raw: { restricted: { payload: "secret" } },
  storageKey: "private/path",
  storageKeyKnowledge: "source",
  checksum: "secret-checksum",
  checksumSha256: "secret-checksum",
  backend: "private-store",
  bucket: "private-bucket",
  key: "private-key",
  generation: "1",
  version: "1",
  signedUrl: "https://private.example.test/signed",
};

function canaryRepository(): SyntheticRentOpsRepository {
  const snapshot = structuredClone(syntheticRentOpsSnapshot()) as unknown as Record<string, unknown> & { recurringSchedules: Array<Record<string, unknown>>; applications: Array<Record<string, unknown>>; documents: unknown[]; applicationRequirements: Array<Record<string, unknown>>; activityEvents: Array<Record<string, unknown>> };
  snapshot.sourceRecords = [canaryFields];
  snapshot.importRuns = [canaryFields];
  snapshot.recurringSchedules[0] = { ...canaryFields, ...snapshot.recurringSchedules[0], chargeDefinitionId: "rm-charge-id", chargeDefinitionKey: "rm-charge-key" };
  snapshot.applications[0] = { ...canaryFields, ...snapshot.applications[0] };
  snapshot.applicationRequirements[0] = { ...canaryFields, ...snapshot.applicationRequirements[0] };
  snapshot.activityEvents[0] = { ...canaryFields, ...snapshot.activityEvents[0] };
  snapshot.documents.push({ ...canaryFields, id: "canary-document", propertyId: "demo-property-a", type: "lease", state: "executed", fileName: "lease.pdf", mimeType: "application/pdf", sizeBytes: 10, storageKey: "documents/canary-document", checksumSha256: "a".repeat(64) });
  return new SyntheticRentOpsRepository(snapshot as never);
}

function historyRaw(values: Record<string, unknown>): RentManagerRawRecord {
  return { entityType: "synthetic", sourceId: String(values.sourceId ?? values.id ?? "history-row"), ...values } as RentManagerRawRecord;
}

/** Use the same exact target ID a native applicant card carries. */
function applicantHistoryRepository(): SyntheticRentOpsRepository {
  const applicationId = "demo-application-1";
  const prospectId = "history-prospect-1";
  const history = projectRentManagerApplicationHistory({
    prospects: [historyRaw({ sourceCollection: "Prospects", sourceId: prospectId, FirstName: "Historical", LastName: "Applicant", Email: "historical@example.test", Status: "active" })],
    applications: [
      historyRaw({ sourceCollection: "Applications", sourceId: "history-application-1", ProspectID: prospectId, FirstName: "Historical", LastName: "Applicant", Email: "historical@example.test", SubmittedOn: "2026-08-10" }),
      historyRaw({ sourceCollection: "Applications", sourceId: "history-application-2", ProspectID: prospectId, FirstName: "Historical", LastName: "Applicant", Email: "historical@example.test", SubmittedOn: "2026-08-11" }),
    ],
    interestedRentals: [
      historyRaw({ sourceCollection: "InterestedRentals", sourceId: "history-interest-1", ApplicationID: "history-application-1", PropertyID: "property-a", UnitID: "unit-a-1", Preference: "first choice", Rent: "1250", Bedrooms: 2 }),
      historyRaw({ sourceCollection: "InterestedRentals", sourceId: "history-interest-2", ApplicationID: "history-application-2", PropertyID: "property-b", UnitID: "unit-b-1", Preference: "sibling-only", Rent: "1500", Bedrooms: 3 }),
    ],
    applicationParticipants: [historyRaw({ sourceCollection: "ApplicationParticipants", sourceId: "history-participant-1", ApplicationID: "history-application-1", Role: "applicant", Relationship: "self", IsMinor: false, IsFinanciallyResponsible: true })],
    applicationRequirements: [historyRaw({ sourceCollection: "ApplicationRequirements", sourceId: "history-requirement-1", ApplicationID: "history-application-1", Label: "Identity document", Status: "requested", RequestedOn: "2026-08-10" })],
    applicationDocuments: [historyRaw({ sourceCollection: "ApplicationDocuments", sourceId: "history-document-1", ApplicationID: "history-application-1", FileName: "identity.pdf", MimeType: "application/pdf", MetadataAvailable: true })],
    activities: [historyRaw({ sourceCollection: "ApplicationHistory", sourceId: "history-activity-1", ApplicationID: "history-application-1", Type: "status_change", OccurredAt: "2026-08-10T12:00:00.000Z", Summary: "Historical safe summary" })],
  }, {
    artifactSha256: "a".repeat(64),
    activitySummaryEvidence: [{ artifactSha256: "a".repeat(64), sourceCollection: "ApplicationHistory", sourceField: "Summary" }],
    targetIdFactory: (entityType, sourceId) => {
      if (entityType === "application" && sourceId.includes("history-application-1")) return applicationId;
      if (entityType === "application" && sourceId.includes("history-application-2")) return "history-application-2";
      if (entityType === "prospect" && sourceId.includes(prospectId)) return prospectId;
      return `history:${entityType}:${sourceId}`;
    },
  });
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.applicationHistory = history;
  return new SyntheticRentOpsRepository(snapshot);
}

function nullableBoundaryRepository(): SyntheticRentOpsRepository {
  const snapshot = structuredClone(syntheticRentOpsSnapshot()) as never as {
    people: Array<Record<string, unknown>>;
    activityEvents: Array<Record<string, unknown>>;
    properties: Array<Record<string, unknown>>;
    units: Array<Record<string, unknown>>;
    leaseTerms: Array<Record<string, unknown>>;
  };
  snapshot.people[0].firstName = null;
  snapshot.people[0].lastName = null;
  snapshot.people[0].email = null;
  snapshot.activityEvents[0].occurredAt = null;
  snapshot.properties[1].name = "Grove with unknown address";
  snapshot.properties[1].address = null;
  const listedUnit = snapshot.units.find((unit) => unit.id === "demo-unit-a-3");
  if (listedUnit) { listedUnit.readiness = null; listedUnit.listing = null; }
  snapshot.leaseTerms[0].contractStartOn = null;
  return new SyntheticRentOpsRepository(snapshot as never);
}

function listingKnowledgeBoundaryRepository(): SyntheticRentOpsRepository {
  const snapshot = structuredClone(syntheticRentOpsSnapshot()) as never as {
    properties: Array<Record<string, unknown>>;
    units: Array<Record<string, unknown>>;
  };
  snapshot.properties[0].source = { system: "rm", entityType: "property", sourceId: "property-a" };
  snapshot.properties[0].nameKnowledge = "source";
  snapshot.properties[0].addressKnowledge = "source";
  snapshot.properties[0].stateKnowledge = "source";
  const unit = snapshot.units.find((candidate) => candidate.id === "demo-unit-a-3");
  if (unit) {
    unit.source = { system: "rm", entityType: "unit", sourceId: "unit-a-3" };
    unit.unitNumberKnowledge = "unknown";
    unit.readinessKnowledge = "source";
    unit.listingKnowledge = "inferred";
    unit.propertyLinkKnowledge = "exact";
  }
  snapshot.properties[1].source = { system: "rm", entityType: "property", sourceId: "property-b" };
  delete snapshot.properties[1].nameKnowledge;
  delete snapshot.properties[1].addressKnowledge;
  delete snapshot.properties[1].stateKnowledge;
  return new SyntheticRentOpsRepository(snapshot as never);
}

function accountContactRepository(): SyntheticRentOpsRepository {
  const snapshot = structuredClone(syntheticRentOpsSnapshot()) as never as {
    people: Array<Record<string, unknown>>;
    householdMemberships: Array<Record<string, unknown>>;
  };
  snapshot.people.push({ id: "demo-account-contact", firstName: "Account", lastName: "Contact", phone: "+1-555-0199" });
  snapshot.householdMemberships.push({ id: "demo-household-account-contact", tenancyId: "demo-tenancy-1", personId: "demo-person-1", accountPersonId: "demo-account-contact", role: "primary", relationship: "account contact" });
  return new SyntheticRentOpsRepository(snapshot as never);
}

function assertNoForbiddenRouteKeys(value: unknown, path = "root"): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertNoForbiddenRouteKeys(item, `${path}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    assert.equal(forbiddenKeys.has(key), false, `${path}.${key} leaked through route boundary`);
    assertNoForbiddenRouteKeys(nested, `${path}.${key}`);
  }
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value as object).sort(), [...expected].sort());
}

async function withServer(options: Parameters<typeof registerRentOpsRoutes>[1], callback: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  registerRentOpsRoutes(app, options);
  const server = await new Promise<http.Server>((resolve) => {
    const value = app.listen(0, () => resolve(value));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/rent-ops`;
  try { await callback(baseUrl); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function request(baseUrl: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> {
  const url = new URL(path.replace(/^\//, ""), `${baseUrl}/`);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? "GET", headers: { Accept: "application/json", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? JSON.parse(text) as Record<string, unknown> : {} }); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(JSON.stringify(init.body));
    req.end();
  });
}

async function requestText(baseUrl: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  const url = new URL(path.replace(/^\//, ""), `${baseUrl}/`);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? "GET", headers: { ...(init.body === undefined ? {} : { "Content-Type": "application/json" }), ...init.headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(JSON.stringify(init.body));
    req.end();
  });
}

async function requestBinary(baseUrl: string, path: string, body: Buffer | undefined, init: { method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const url = new URL(path.replace(/^\//, ""), `${baseUrl}/`);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? "GET", headers: { ...(body === undefined ? {} : { "Content-Length": String(body.byteLength) }), ...init.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("public listings are safe, public start fails closed generically, and headers prevent caching", async () => {
  await withServer({ repository: createSyntheticRentOpsRepository() }, async (baseUrl) => {
    const listings = await request(baseUrl, "/public/listings");
    assert.equal(listings.status, 200);
    assert.equal(listings.headers["cache-control"], "no-store");
    assert.equal(listings.headers["referrer-policy"], "no-referrer");
    assert.ok(Array.isArray(listings.body));
    const property = (listings.body as unknown as Array<Record<string, unknown>>)[0];
    assert.equal(property.slug, "demo-harbor");
    const units = property.units as Array<Record<string, unknown>>;
    assert.equal(units.some((unit) => unit.id === "demo-unit-a-1"), false);
    assert.equal(units.some((unit) => unit.id === "demo-unit-a-2"), false);
    assert.equal(units.some((unit) => unit.id === "demo-unit-a-3"), true);
    assert.equal(units.some((unit) => unit.id === "demo-unit-a-4"), false);
    assert.equal(units.some((unit) => unit.id === "demo-unit-a-5"), false);
    assert.equal((property as Record<string, unknown>).address, undefined);
    const started = await request(baseUrl, "/public/applications/start", { method: "POST", body });
    assert.equal(started.status, 503);
    assert.deepEqual(started.body, { code: "temporarily_unavailable" });
    assert.equal(JSON.stringify(started.body).includes("resume"), false);
  });
});

test("applicant binary upload authenticates before streaming, verifies magic, and admin download is ID-only", async () => {
  const repository = createSyntheticRentOpsRepository();
  const storage = createInMemoryObjectStore();
  let deliveredToken = "";
  await withServer({
    repository,
    documentStorage: storage,
    enableDemoGuard: true,
    exposeResumeToken: true,
    resumeTokenNotifier: async ({ token }) => { deliveredToken = token; },
    requireAdmin: (_req, _res, next) => next(),
  }, async (baseUrl) => {
    const started = await request(baseUrl, "/public/applications/start", { method: "POST", body });
    assert.equal(started.status, 202);
    const applicationId = (await repository.getSnapshot()).applications.find((candidate) => candidate.email === body.email)?.id;
    assert.ok(applicationId);
    const requirement = await request(baseUrl, `/applications/${encodeURIComponent(applicationId!)}/requirements`, { method: "POST", body: { key: "identity", label: "Identity document", status: "requested", requestedOn: "2026-08-16" } });
    assert.equal(requirement.status, 201);
    const requirementId = typeof requirement.body.id === "string" ? requirement.body.id : "";
    const bytes = Buffer.from("%PDF-1.7\nroute upload");
    const uploaded = await requestBinary(baseUrl, "/public/applications/resume/documents", bytes, { method: "POST", headers: {
      Authorization: `Bearer ${deliveredToken}`,
      "Content-Type": "application/pdf",
      "X-Document-Type": "identity",
      "X-Document-Name": "identity.pdf",
      "X-Application-Requirement-Id": requirementId,
    } });
    assert.equal(uploaded.status, 201, uploaded.body.toString("utf8"));
    assert.equal(uploaded.headers["cache-control"], "no-store");
    const uploadedView = JSON.parse(uploaded.body.toString("utf8")) as Record<string, unknown>;
    assertNoForbiddenRouteKeys(uploadedView);
    const uploadedDocument = (uploadedView.documents as Array<Record<string, unknown>>)[0];
    assert.equal(uploadedDocument.state, "verified");
    // The applicant response has no download URL or storage proof; the
    // authenticated admin proxy is the only download surface.
    assert.equal(uploadedDocument.downloadAvailable, false);
    assert.equal("storageKey" in uploadedDocument, false);

    const documentId = String(uploadedDocument.id);
    const downloaded = await requestBinary(baseUrl, `/documents/${encodeURIComponent(documentId)}/download?storageKey=ignored`, undefined, { headers: { Accept: "application/octet-stream" } });
    assert.equal(downloaded.status, 200);
    assert.deepEqual(downloaded.body, bytes);
    assert.equal(downloaded.headers["cache-control"], "no-store");
    assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
    assert.equal(downloaded.headers["content-type"], "application/pdf");
    assert.match(String(downloaded.headers["content-disposition"]), /identity\.pdf/);

    const metadata = await request(baseUrl, "/public/applications/resume/documents", { method: "POST", headers: { Authorization: `Bearer ${deliveredToken}`, "Content-Type": "application/json" }, body: { type: "identity", fileName: "pretend.pdf", mimeType: "application/pdf" } });
    assert.equal(metadata.status, 503);
    assert.deepEqual(metadata.body, { code: "verified_upload_required" });

    const badMagic = await requestBinary(baseUrl, "/public/applications/resume/documents", Buffer.from("not a PDF"), { method: "POST", headers: { Authorization: `Bearer ${deliveredToken}`, "Content-Type": "application/pdf", "X-Document-Type": "identity", "X-Document-Name": "bad.pdf" } });
    assert.equal(badMagic.status, 400);
    const arbitraryId = await requestBinary(baseUrl, "/public/applications/resume/documents", bytes, { method: "POST", headers: { Authorization: `Bearer ${deliveredToken}`, "Content-Type": "application/pdf", "X-Document-Type": "identity", "X-Document-Name": "other.pdf", "X-Document-ID": "document:attacker" } });
    assert.equal(arbitraryId.status, 400);
  });
});

test("unauthenticated binary upload is rejected before the body reader runs", async () => {
  await withServer({ repository: createSyntheticRentOpsRepository(), documentStorage: createInMemoryObjectStore(), enableDemoGuard: true, exposeResumeToken: true }, async (baseUrl) => {
    const response = await requestBinary(baseUrl, "/public/applications/resume/documents", Buffer.from("%PDF-1.7\nprivate"), { method: "POST", headers: { "Content-Type": "application/pdf", "X-Document-Type": "identity", "X-Document-Name": "private.pdf" } });
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body.toString("utf8")), { code: "not_found" });
  });
});

test("provider delivery failures return the same generic 503 as a timeout", async () => {
  await withServer({ repository: createSyntheticRentOpsRepository(), resumeTokenNotifier: async () => { throw new Error("provider detail must not escape"); } }, async (baseUrl) => {
    const started = await request(baseUrl, "/public/applications/start", { method: "POST", body });
    assert.equal(started.status, 503);
    assert.deepEqual(started.body, { code: "temporarily_unavailable" });
  });
});

test("application start is an exact acceptance response; delivery token stays out of views and snapshots", async () => {
  let deliveredToken = "";
  await withServer({ repository: createSyntheticRentOpsRepository(), enableDemoGuard: true, exposeResumeToken: true, resumeTokenNotifier: async ({ token }) => { deliveredToken = token; }, requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const started = await request(baseUrl, "/public/applications/start", { method: "POST", body });
    assert.equal(started.status, 202);
    exactKeys(started.body, ["accepted"]);
    assert.deepEqual(started.body, { accepted: true });
    assert.match(deliveredToken, /^[A-Za-z0-9_-]{40,100}$/);
    const view = await request(baseUrl, "/public/applications/resume", { headers: { Authorization: `Bearer ${deliveredToken}` } });
    assert.equal(view.status, 200);
    assert.equal(view.body.resumeTokenHash, undefined);
    const snapshot = await request(baseUrl, "/snapshot");
    assert.equal(snapshot.status, 200);
    assert.ok(snapshot.body.applicants);
    assert.equal("raw" in snapshot.body, false);
    assert.equal((snapshot.body.tenants as Array<{ person: { id: string } }>).some((tenant) => tenant.person.id === "demo-person-4"), false);
    assert.equal(JSON.stringify(snapshot.body).includes("resumeTokenHash"), false);
    assert.equal(JSON.stringify(snapshot.body).includes("resumeTokenExpiresAt"), false);
    assertNoForbiddenRouteKeys(snapshot.body);
  });
});

test("admin routes require injected authentication and strict writes reject unknown fields", async () => {
  await withServer({ repository: createSyntheticRentOpsRepository() }, async (baseUrl) => {
    const denied = await request(baseUrl, "/dashboard");
    assert.equal(denied.status, 401);
  });
  await withServer({ repository: createSyntheticRentOpsRepository(), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const invalid = await request(baseUrl, "/properties", { method: "POST", body: { id: "bad", name: "Bad", slug: "bad", address: { line1: "x", city: "x", state: "ZZ", postalCode: "0" }, propertyType: "multifamily", state: "active", unexpected: true } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, { code: "invalid_input" });
    assert.equal(invalid.headers["cache-control"], "no-store");
  });
});

test("malformed and unknown resume tokens share the same generic response", async () => {
  await withServer({ repository: createSyntheticRentOpsRepository() }, async (baseUrl) => {
    const malformed = await request(baseUrl, "/public/applications/resume", { headers: { Authorization: "Bearer nope" } });
    const unknown = await request(baseUrl, "/public/applications/resume", { headers: { Authorization: `Bearer ${"A".repeat(48)}` } });
    assert.equal(malformed.status, 404);
    assert.equal(unknown.status, 404);
    assert.deepEqual(malformed.body, unknown.body);
    assert.deepEqual(malformed.body, { code: "not_found" });
  });
});

test("public application resume never places its credential in the request path", async () => {
  let deliveredToken = "";
  await withServer({ repository: createSyntheticRentOpsRepository(), enableDemoGuard: true, resumeTokenNotifier: async ({ token }) => { deliveredToken = token; } }, async (baseUrl) => {
    const started = await request(baseUrl, "/public/applications/start", { method: "POST", body });
    assert.deepEqual(started.body, { accepted: true });
    const headers = { Authorization: `Bearer ${deliveredToken}` };
    const resumed = await request(baseUrl, "/public/applications/resume", { headers });
    assert.equal(resumed.status, 200);
    const saved = await request(baseUrl, "/public/applications/resume", { method: "PATCH", headers, body: { phone: "+1-555-0199" } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.phone, "+1-555-0199");
    assert.equal("resumeTokenHash" in saved.body, false);
  });
});

test("default-date reports reject an elapsed future tenancy until its actual status is corrected", async (context) => {
  context.mock.timers.setTime(new Date("2026-09-07T12:00:00.000Z").getTime());
  const repository = createSyntheticRentOpsRepository();
  await withServer({ repository, requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const dashboard = await request(baseUrl, "/dashboard");
    assert.equal(dashboard.status, 400);
    const historical = await request(baseUrl, "/dashboard?asOfDate=2026-08-16");
    assert.equal(historical.status, 200);
  });

  const correctedSnapshot = structuredClone(syntheticRentOpsSnapshot());
  correctedSnapshot.tenancies.find((tenancy) => tenancy.id === "demo-tenancy-2")!.status = "current";
  await withServer({ repository: new SyntheticRentOpsRepository(correctedSnapshot), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const dashboard = await request(baseUrl, "/dashboard");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.occupiedUnits, 3);
  });
});

test("manager preview context and omitted reports follow the injected business clock", async () => {
  const correctedSnapshot = structuredClone(syntheticRentOpsSnapshot());
  const movedInTenancy = correctedSnapshot.tenancies.find((tenancy) => tenancy.id === "demo-tenancy-2")!;
  movedInTenancy.status = "current";
  movedInTenancy.actualMoveInOn = "2026-10-01";
  const businessDate = new Date("2026-10-01T15:00:00.000Z");
  await withServer({ repository: new SyntheticRentOpsRepository(correctedSnapshot), now: () => businessDate }, async (baseUrl) => {
    const context = await request(baseUrl, "/preview-context");
    assert.equal(context.status, 401);
  });
  await withServer({
    repository: new SyntheticRentOpsRepository(correctedSnapshot),
    requireAdmin: (_req, _res, next) => next(),
    now: () => businessDate,
    previewSource: "synthetic",
  }, async (baseUrl) => {
    const context = await request(baseUrl, "/preview-context");
    assert.equal(context.status, 200);
    assert.deepEqual(context.body, { asOfDate: "2026-10-01", dataMode: "synthetic" });

    const dashboard = await request(baseUrl, "/dashboard");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.asOfDate, "2026-10-01");

    const earlierDashboard = await request(baseUrl, "/dashboard?asOfDate=2026-09-07");
    assert.equal(earlierDashboard.status, 400);

    const snapshot = await request(baseUrl, "/snapshot");
    assert.equal(snapshot.status, 200);
    assert.equal((snapshot.body.summary as Record<string, unknown>).asOfDate, "2026-10-01");
  });
});

test("admin report routes default to active properties and expose imported history explicitly", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.properties.push({ id: "historical-property", name: "Historical property", slug: "historical-property", address: { line1: "1 Old Way", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: null });
  snapshot.units.push({ id: "historical-unit", propertyId: "historical-property", unitNumber: "H-1", readiness: "ready", listing: "listed" });
  await withServer({ repository: new SyntheticRentOpsRepository(snapshot), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const active = await request(baseUrl, "/dashboard");
    assert.equal(active.status, 200);
    assert.equal(active.body.propertyCount, 2);
    assert.equal(active.body.unitCount, 7);
    const allImported = await request(baseUrl, "/dashboard?propertyScope=all");
    assert.equal(allImported.status, 200);
    assert.equal(allImported.body.propertyCount, 3);
    assert.equal(allImported.body.unitCount, 8);
  });
});

test("admin snapshot tenant and applicant cards follow the selected property scope", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot());
  snapshot.properties.push({ id: "historical-property", name: "Historical property", slug: "historical-property", address: { line1: "1 Old Way", city: "Town", state: "FL", postalCode: "00000" }, propertyType: "multifamily", state: null });
  snapshot.units.push({ id: "historical-unit", propertyId: "historical-property", unitNumber: "H-1", readiness: "ready", listing: "listed" });
  snapshot.people.push({ id: "historical-person", firstName: "Historical", lastName: "Resident", email: "historical.resident@example.test", phone: "+1-555-0198" });
  snapshot.tenancies.push({ id: "historical-tenancy", propertyId: "historical-property", unitId: "historical-unit", primaryPersonId: "historical-person", status: "past", actualMoveInOn: "2020-01-01", actualMoveOutOn: "2020-12-31", createdAt: "2020-01-01T12:00:00.000Z" });
  snapshot.householdMemberships.push({ id: "historical-household", tenancyId: "historical-tenancy", personId: "historical-person", role: "primary", isFinanciallyResponsible: true });
  snapshot.applications.push({ id: "historical-application", sourceType: "manual", status: "submitted", email: "historical.applicant@example.test", firstName: "Historical", lastName: "Applicant", phone: "+1-555-0197", propertyId: "historical-property", createdAt: "2020-01-01T12:00:00.000Z", updatedAt: "2020-01-02T12:00:00.000Z", submittedOn: "2020-01-02" });
  await withServer({ repository: new SyntheticRentOpsRepository(snapshot), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const active = await request(baseUrl, "/snapshot");
    assert.equal(active.status, 200);
    const activeTenants = active.body.tenants as Array<{ person: { id: string } }>;
    const activeApplicants = active.body.applicants as Array<{ id: string }>;
    assert.equal(activeTenants.some((tenant) => tenant.person.id === "demo-person-1"), true);
    assert.equal(activeTenants.some((tenant) => tenant.person.id === "historical-person"), false);
    assert.equal(activeApplicants.some((application) => application.id === "historical-application"), false);

    const activePipeline = await request(baseUrl, "/applications");
    assert.equal(activePipeline.status, 200);
    assert.equal((activePipeline.body as Array<{ id: string }>).some((application) => application.id === "historical-application"), false);

    const allImported = await request(baseUrl, "/snapshot?propertyScope=all");
    assert.equal(allImported.status, 200);
    const allTenants = allImported.body.tenants as Array<{ person: { id: string } }>;
    const allApplicants = allImported.body.applicants as Array<{ id: string }>;
    assert.equal(allTenants.some((tenant) => tenant.person.id === "historical-person"), true);
    assert.equal(allApplicants.some((application) => application.id === "historical-application"), true);

    const allPipeline = await request(baseUrl, "/applications?propertyScope=all");
    assert.equal(allPipeline.status, 200);
    assert.equal((allPipeline.body as Array<{ id: string }>).some((application) => application.id === "historical-application"), true);
  });
});

test("invalid filters and malformed financial writes fail with 400 instead of silent defaults", async () => {
  await withServer({ repository: createSyntheticRentOpsRepository(), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    assert.equal((await request(baseUrl, "/reports/rent-roll?asOfDate=2026-02-31")).status, 400);
    assert.equal((await request(baseUrl, "/reports/rent-roll?occupancy=current,not-a-state")).status, 400);

    const common = { id: "route-ledger", propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", personId: "demo-person-1", category: "base_rent", status: "posted", amountCents: 100, postedOn: "2026-08-10", description: "Synthetic route test" };
    assert.equal((await request(baseUrl, "/ledger/transactions", { method: "POST", body: { ...common, kind: "reversal" } })).status, 400);
    assert.equal((await request(baseUrl, "/ledger/transactions", { method: "POST", body: { ...common, kind: "adjustment" } })).status, 400);
    assert.equal((await request(baseUrl, "/ledger/transactions", { method: "POST", body: { ...common, kind: "charge", amountCents: 2_147_483_648 } })).status, 400);
  });
});

test("admin and public routes enforce nested positive allowlists, including reports and CSV", async () => {
  await withServer({ repository: canaryRepository(), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const listings = await request(baseUrl, "/public/listings");
    assert.equal(listings.status, 200);
    assertNoForbiddenRouteKeys(listings.body);
    const listing = (listings.body as unknown as Array<Record<string, unknown>>)[0];
    exactKeys(listing, ["id", "name", "slug", "units"]);
    exactKeys((listing.units as Array<Record<string, unknown>>)[0], ["id", "unitNumber", "unitType", "bedrooms", "bathrooms", "marketRentCents"]);

    const snapshot = await request(baseUrl, "/snapshot");
    assert.equal(snapshot.status, 200);
    assertNoForbiddenRouteKeys(snapshot.body);
    exactKeys(snapshot.body, ["generatedAt", "summary", "snapshot", "rentRoll", "occupancy", "scheduledIncome", "collectedIncome", "scheduledVsCollected", "delinquency", "ledger", "leaseExpiration", "depositLiability", "hap", "tenants", "applicants", "documents", "activities", "reports"]);
    assert.equal("raw" in snapshot.body, false);
    exactKeys(snapshot.body.snapshot, ["properties", "units", "people", "householdMemberships", "tenancies", "leaseTerms", "recurringSchedules", "ledgerTransactions", "paymentAllocations", "securityDeposits", "subsidyContracts", "applications", "applicationHouseholdMembers", "applicationRequirements", "documents", "activityEvents"]);
    assert.equal((snapshot.body.snapshot as Record<string, any>).recurringSchedules[0].chargeDefinitionId, "rm-charge-id");
    assert.equal("chargeDefinitionKey" in (snapshot.body.snapshot as Record<string, unknown>).recurringSchedules[0], false);

    const dashboard = await request(baseUrl, "/dashboard");
    assert.equal(dashboard.status, 200);
    assertNoForbiddenRouteKeys(dashboard.body);
    const report = await request(baseUrl, "/reports/tenant-ledger");
    assert.equal(report.status, 200);
    assertNoForbiddenRouteKeys(report.body);
    exactKeys(report.body, ["report", "filters", "rows"]);
    const unknownReport = await request(baseUrl, "/reports/not-a-report");
    assert.equal(unknownReport.status, 404);
    assert.deepEqual(unknownReport.body, { code: "unknown_report" });
    const csv = await requestText(baseUrl, "/reports/scheduled-income/csv");
    assert.equal(csv.status, 200);
    assert.equal(csv.text.includes("chargeDefinitionId"), false);
    assert.equal(csv.text.includes("chargeDefinitionKey"), false);
    assert.equal(csv.text.includes("storageKey"), false);

    const properties = await request(baseUrl, "/properties");
    assert.equal(properties.status, 200);
    assertNoForbiddenRouteKeys(properties.body);
    exactKeys((properties.body as unknown as Array<Record<string, unknown>>)[0], ["id", "name", "slug", "address", "propertyType", "state", "operatingContact"]);
    exactKeys(((properties.body as unknown as Array<Record<string, unknown>>)[0].address), ["line1", "city", "state", "postalCode"]);

    const units = await request(baseUrl, "/units?propertyId=demo-property-a");
    assert.equal(units.status, 200);
    assertNoForbiddenRouteKeys(units.body);
    exactKeys((units.body as unknown as Array<Record<string, unknown>>)[0], ["id", "propertyId", "unitNumber", "unitType", "bedrooms", "bathrooms", "squareFeet", "marketRentCents", "defaultDepositCents", "readiness", "listing"]);

    const tenants = await request(baseUrl, "/tenants");
    assert.equal(tenants.status, 200);
    assertNoForbiddenRouteKeys(tenants.body);
    exactKeys((tenants.body as unknown as Array<Record<string, unknown>>)[0], ["id", "firstName", "lastName", "email", "phone", "renterInsuranceExpiresOn"]);

    for (const path of ["/tenants/demo-person-1", "/applications", "/applications/demo-application-1", "/documents", "/activity", "/ledger/demo-tenancy-1", "/reports/applicant-pipeline"]) {
      const response = await request(baseUrl, path);
      assert.equal(response.status, 200, path);
      assertNoForbiddenRouteKeys(response.body);
    }
    const document = ((await request(baseUrl, "/documents")).body as unknown as Array<Record<string, unknown>>).find((item) => item.id === "canary-document");
    assert.ok(document);
    exactKeys(document, ["id", "propertyId", "type", "state", "fileName", "mimeType", "sizeBytes", "downloadAvailable"]);
    assert.equal("storageKeyKnowledge" in document, false);
    // Metadata-only rows (including pending applicant keys) are never
    // presented as downloadable until a verified binding exists.
    assert.equal(document.downloadAvailable, false);
  });
});

test("applicant card target opens the same historical case ID without cross-application evidence", async () => {
  await withServer({ repository: applicantHistoryRepository(), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const nativeDetail = await request(baseUrl, "/applications/demo-application-1");
    assert.equal(nativeDetail.status, 200);
    assert.equal(nativeDetail.body.id, "demo-application-1");
    assertNoForbiddenRouteKeys(nativeDetail.body);
    const history = nativeDetail.body.history as Record<string, unknown>;
    assert.equal((history.application as Record<string, unknown>).id, "demo-application-1");
    assert.equal((history.interests as unknown[]).length, 1);
    assert.equal((history.participants as unknown[]).length, 1);
    assert.equal((history.documents as unknown[]).length, 1);
    assert.equal(JSON.stringify(nativeDetail.body).includes("history-application-1"), false);
    assert.equal(JSON.stringify(nativeDetail.body).includes("Historical safe summary"), true);
    assert.equal(JSON.stringify(nativeDetail.body).includes("sourceId"), false);
    assert.equal(JSON.stringify(nativeDetail.body).includes("metadataChecksumSha256"), false);

    const narrowDetail = await request(baseUrl, "/applications/demo-application-1/history");
    assert.equal(narrowDetail.status, 200);
    assert.deepEqual(narrowDetail.body, history);

    // A sibling application sharing the same prospect gets only its own
    // occurrence; the exact application binding remains the isolation boundary.
    const sibling = await request(baseUrl, "/applications/history-application-2/history");
    assert.equal(sibling.status, 200);
    const siblingHistory = sibling.body as Record<string, unknown>;
    assert.equal((siblingHistory.application as Record<string, unknown>).id, "history-application-2");
    const siblingInterests = siblingHistory.interests as Array<Record<string, unknown>>;
    assert.equal(siblingInterests.length, 1);
    assert.equal(siblingInterests[0].preference, "sibling-only");
    assert.equal(JSON.stringify(siblingHistory).includes("first choice"), false);
  });
});

test("admin POSTs reject existing tenancy and lease IDs instead of upserting imported rows", async () => {
  await withServer({ repository: createSyntheticRentOpsRepository(), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const tenancy = await request(baseUrl, "/tenancies", {
      method: "POST",
      body: { id: "demo-tenancy-1", propertyId: "demo-property-a", unitId: "demo-unit-a-1", primaryPersonId: "demo-person-1", status: "current", actualMoveInOn: "2026-01-01", createdAt: "2030-01-01T00:00:00.000Z" },
    });
    assert.equal(tenancy.status, 400);
    assert.deepEqual(tenancy.body, { code: "invalid_input" });

    const lease = await request(baseUrl, "/lease-terms", {
      method: "POST",
      body: { id: "demo-term-1", tenancyId: "demo-tenancy-1", status: "executed", contractStartOn: "2026-01-01", contractEndOn: "2026-09-15", monthToMonth: false, signedOn: "2025-12-20", createdAt: "2030-01-01T00:00:00.000Z" },
    });
    assert.equal(lease.status, 400);
    assert.deepEqual(lease.body, { code: "invalid_input" });

    const missingFutureMoveIn = await request(baseUrl, "/tenancies", {
      method: "POST",
      body: { id: "new-tenancy-without-created-at", propertyId: "demo-property-a", unitId: "demo-unit-a-3", primaryPersonId: "demo-person-2", status: "future", actualMoveInOn: "2027-01-01" },
    });
    assert.equal(missingFutureMoveIn.status, 400);
    assert.deepEqual(missingFutureMoveIn.body, { code: "request_failed" });
  });
});

test("nullable v3 facts fail closed in route sorting and public inventory", async () => {
  await withServer({ repository: nullableBoundaryRepository(), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const listings = await request(baseUrl, "/public/listings");
    assert.equal(listings.status, 200);
    assertNoForbiddenRouteKeys(listings.body);
    const properties = listings.body as unknown as Array<Record<string, unknown>>;
    assert.equal(properties.some((property) => property.id === "demo-property-b"), false);
    assert.equal((properties[0].units as Array<Record<string, unknown>>).some((unit) => unit.id === "demo-unit-a-3"), false);

    const tenants = await request(baseUrl, "/tenants?search=tenant");
    assert.equal(tenants.status, 200);
    assertNoForbiddenRouteKeys(tenants.body);
    const dashboard = await request(baseUrl, "/dashboard");
    assert.equal(dashboard.status, 200);
    assertNoForbiddenRouteKeys(dashboard.body);
    const snapshot = await request(baseUrl, "/snapshot");
    assert.equal(snapshot.status, 200);
    assertNoForbiddenRouteKeys(snapshot.body);
    const activity = await request(baseUrl, "/activity");
    assert.equal(activity.status, 200);
    assertNoForbiddenRouteKeys(activity.body);
  });
});

test("public listing routes exclude imported undefined, unknown, and inferred knowledge", async () => {
  const repository = listingKnowledgeBoundaryRepository();
  await withServer({ repository, requireAdmin: (req, _res, next) => { req.rentOpsAdminUser = { id: "route-test-admin" } as never; next(); } }, async (baseUrl) => {
    const listings = await request(baseUrl, "/public/listings");
    assert.equal(listings.status, 200);
    const rows = listings.body as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => row.id), ["demo-property-a"]);
    assert.deepEqual((rows[0].units as Array<Record<string, unknown>>).map((unit) => unit.id), []);
    assertNoForbiddenRouteKeys(rows);
  });
});

test("admin tenant bundle includes exact account contacts without inventing tenancy", async () => {
  await withServer({ repository: accountContactRepository(), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const snapshot = await request(baseUrl, "/snapshot");
    assert.equal(snapshot.status, 200);
    const tenants = snapshot.body.tenants as Array<Record<string, unknown>>;
    const account = tenants.find((tenant) => (tenant.person as Record<string, unknown> | undefined)?.id === "demo-account-contact");
    assert.ok(account);
    assert.equal(account?.tenancy, undefined);
    assert.deepEqual(account?.tenancies, []);
    const household = account?.household as Array<Record<string, unknown>>;
    assert.equal(household.some((membership) => membership.accountPersonId === "demo-account-contact"), true);
    assert.equal(JSON.stringify(account).includes("inferred"), false);
  });
});

test("manual PATCH routes use revisions, preserve hidden provenance, and reject stale/recurring edits", async () => {
  const snapshot = structuredClone(syntheticRentOpsSnapshot()) as never as {
    properties: Array<Record<string, unknown>>;
    units: Array<Record<string, unknown>>;
    people: Array<Record<string, unknown>>;
    householdMemberships: Array<Record<string, unknown>>;
    tenancies: Array<Record<string, unknown>>;
    leaseTerms: Array<Record<string, unknown>>;
    securityDeposits: Array<Record<string, unknown>>;
    subsidyContracts: Array<Record<string, unknown>>;
    applications: Array<Record<string, unknown>>;
    documents: Array<Record<string, unknown>>;
    activityEvents: Array<Record<string, unknown>>;
  };
  snapshot.properties[0].source = { system: "rm", sourceId: "property-source" };
  snapshot.properties[0].nameKnowledge = "source";
  snapshot.properties[0].addressKnowledge = "source";
  snapshot.securityDeposits[0].receivedOn = undefined;
  snapshot.securityDeposits[0].receivedOnKnowledge = "unknown";
  snapshot.documents.push({ id: "demo-document-patch", propertyId: "demo-property-a", type: "lease", state: "requested", fileName: "lease.pdf", mimeType: "application/pdf", storageKey: "documents/demo-document-patch", uploadedAt: "2026-08-16T12:00:00.000Z" });
  const repository = new SyntheticRentOpsRepository(snapshot as never);
  await withServer({ repository, requireAdmin: (req, _res, next) => { req.rentOpsAdminUser = { id: "route-test-admin" } as never; next(); } }, async (baseUrl) => {
    const changed = await request(baseUrl, "/properties/demo-property-a", { method: "PATCH", body: { revision: 1, name: "Operator Harbor Homes" } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.name, "Operator Harbor Homes");
    assert.equal(changed.body.recordRevision, 2);
    assert.equal(changed.body.nameKnowledge, "manual");
    assert.equal(changed.body.addressKnowledge, "source");
    assertNoForbiddenRouteKeys(changed.body);

    const stale = await request(baseUrl, "/properties/demo-property-a", { method: "PATCH", body: { revision: 1, slug: "stale-write" } });
    assert.equal(stale.status, 409);
    assert.deepEqual(stale.body, { code: "conflict" });
    const forged = await request(baseUrl, "/properties/demo-property-a", { method: "PATCH", body: { revision: 2, nameKnowledge: "source" } });
    assert.equal(forged.status, 400);
    assert.deepEqual(forged.body, { code: "invalid_input" });
    const forgedNested = await request(baseUrl, "/applications/demo-application-1", { method: "PATCH", body: { revision: 1, profileAnswers: { source: "forged" } } });
    assert.equal(forgedNested.status, 400);
    assert.deepEqual(forgedNested.body, { code: "invalid_input" });

    const noOp = await request(baseUrl, "/properties/demo-property-a", { method: "PATCH", body: { revision: 2, name: "Operator Harbor Homes" } });
    assert.equal(noOp.status, 200);
    assert.equal(noOp.body.recordRevision, 2);
    const changes = await repository.getRecordChanges!();
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].changedFields, ["name"]);

    const supportedNoOps: Array<[string, Record<string, unknown>]> = [
      ["/units/demo-unit-a-1", { revision: 1, unitNumber: "1A" }],
      ["/people/demo-person-1", { revision: 1, firstName: "Tenant" }],
      ["/household-memberships/demo-household:demo-tenancy-1:primary", { revision: 1, role: "primary" }],
      ["/tenancies/demo-tenancy-1", { revision: 1, status: "current" }],
      ["/lease-terms/demo-term-1", { revision: 1, status: "executed" }],
      ["/deposits/demo-deposit-1", { revision: 1, dispositionStatus: "held" }],
      ["/subsidies/demo-subsidy-1", { revision: 1, status: "active" }],
      ["/applications/demo-application-1", { revision: 1, status: "submitted" }],
      ["/documents/demo-document-patch", { revision: 1, state: "requested" }],
    ];
    for (const [path, patchBody] of supportedNoOps) {
      const response = await request(baseUrl, path, { method: "PATCH", body: patchBody });
      assert.equal(response.status, 200, path);
      assertNoForbiddenRouteKeys(response.body);
    }

    const unsupportedHapEdit = await request(baseUrl, "/subsidies/demo-subsidy-1", { method: "PATCH", body: { revision: 1, agencyName: "Forged HAP fact" } });
    assert.equal(unsupportedHapEdit.status, 400);
    assert.deepEqual(unsupportedHapEdit.body, { code: "invalid_input" });

    const beforeHapCreate = await repository.getSnapshot();
    const unsupportedHapCreate = await request(baseUrl, "/subsidies", { method: "POST", body: { id: "native-hap", propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", agencyName: "New agency", effectiveFrom: "2026-08-16", agencyObligationCents: 50000, tenantObligationCents: 50000, status: "active" } });
    assert.equal(unsupportedHapCreate.status, 409);
    assert.deepEqual(unsupportedHapCreate.body, { code: "hap_create_requires_provenance" });
    assert.deepEqual((await repository.getSnapshot()).subsidyContracts, beforeHapCreate.subsidyContracts);

    const activityEdit = await request(baseUrl, "/activity/demo-activity-1", { method: "PATCH", body: { revision: 1, summary: "Do not rewrite history" } });
    assert.equal(activityEdit.status, 409);
    assert.deepEqual(activityEdit.body, { code: "activity_append_only" });

    const scheduleEdit = await request(baseUrl, "/recurring-schedules/demo-schedule-1", { method: "PATCH", body: { revision: 1, description: "Do not edit in place" } });
    assert.equal(scheduleEdit.status, 409);
    assert.deepEqual(scheduleEdit.body, { code: "versioned_schedule_required" });
    const after = await repository.getSnapshot();
    const deposit = after.securityDeposits.find((candidate) => candidate.id === "demo-deposit-1") as unknown as Record<string, unknown>;
    assert.equal(deposit.receivedOn, undefined);
    assert.equal(deposit.receivedOnKnowledge, "unknown");
  });
});

test("manual recurring root rejects an admin middleware without a stable subject", async () => {
  await withServer({ repository: createSyntheticRentOpsRepository(), requireAdmin: (_req, _res, next) => next() }, async (baseUrl) => {
    const response = await request(baseUrl, "/recurring-schedules", { method: "POST", body: {} });
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { code: "not_authorized" });
  });
});

test("manual recurring root accepts only a positive body and authenticated subject", async () => {
  await withServer({
    repository: createSyntheticRentOpsRepository(),
    requireAdmin: (req, _res, next) => { req.rentOpsAdminUser = { id: "rent-ops-admin-session" } as never; next(); },
  }, async (baseUrl) => {
    const spoofed = await request(baseUrl, "/recurring-schedules", {
      method: "POST",
      body: {
        id: "schedule:manual-root",
        billingFrequency: "monthly",
        scopeType: "property",
        scopeId: "demo-property-a",
        propertyId: "demo-property-a",
        chargeDefinitionId: "demo-charge-definition-utility-fee",
        category: "recurring_fee",
        description: "Manual utility fee",
        amountCents: 5000,
        effectiveFrom: "2027-01-01",
        active: true,
        source: { system: "forged" },
      },
    });
    assert.equal(spoofed.status, 400);
    assert.deepEqual(spoofed.body, { code: "invalid_input" });
    const accepted = await request(baseUrl, "/recurring-schedules", {
      method: "POST",
      body: {
        id: "schedule:manual-root",
        billingFrequency: "monthly",
        scopeType: "property",
        scopeId: "demo-property-a",
        propertyId: "demo-property-a",
        chargeDefinitionId: "demo-charge-definition-utility-fee",
        category: "recurring_fee",
        description: "Manual utility fee",
        amountCents: 5000,
        effectiveFrom: "2027-01-01",
        active: true,
      },
    });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.chargeDefinitionId, "demo-charge-definition-utility-fee");
    assert.equal("source" in accepted.body, false);
  });
});

test("Quick Add UI-shaped tenancy and lease requests use trusted server creation timestamps", async () => {
  const { mutationPayload } = await import("../../client/src/features/rent-ops/form-payload");
  const repository = createSyntheticRentOpsRepository();
  const snapshot = await repository.getSnapshot();
  const unit = snapshot.units[0];
  const now = "2026-08-16T12:00:00.000Z";
  await withServer({ repository, now: () => new Date(now), requireAdmin: (req, _res, next) => { req.rentOpsAdminUser = {id:"manager"} as any; next(); } }, async base => {
    const tenancy = mutationPayload("save-tenancy", { id: "manual:ui-tenancy", propertyId: unit.propertyId, unitId: unit.id, primaryPersonId: snapshot.people[0].id, status: "past", actualMoveInOn: "2020-01-01", actualMoveOutOn: "2020-12-31" });
    assert.equal("createdAt" in tenancy, false);
    const created = await request(base, "/tenancies", { method:"POST", body:tenancy });
    assert.equal(created.status, 201);
    assert.equal((await repository.getSnapshot()).tenancies.find(t=>t.id===tenancy.id)?.createdAt, now);
    const lease = mutationPayload("save-lease-term", { id:"manual:ui-lease", tenancyId:String(tenancy.id), status:"expired", contractStartOn:"2020-01-01", contractEndOn:"2020-12-31", monthToMonth:false });
    assert.equal("createdAt" in lease, false);
    assert.equal((await request(base,"/lease-terms",{method:"POST",body:lease})).status,201);
    assert.equal((await repository.getSnapshot()).leaseTerms.find(t=>t.id===lease.id)?.createdAt, now);
    assert.equal((await request(base,"/tenancies",{method:"POST",body:{...tenancy,createdAt:"2000-01-01T00:00:00Z"}})).status,400);
    assert.equal((await repository.getSnapshot()).tenancies.find(t=>t.id===tenancy.id)?.createdAt, now);
  });
});

test("person phone methods save and read back with audit, exact revision, and strict curated fields",async()=>{
 const snapshot=syntheticRentOpsSnapshot();
 const repository=new SyntheticRentOpsRepository(snapshot);
 const originalPhone=snapshot.people[0].phone;
 const methods=[{id:"method-one",value:"+1 555 0100",type:"Mobile",isPrimary:true,isTextReady:false},{value:"555 0101"}];
 await withServer({repository,requireAdmin:(req,_res,next)=>{req.rentOpsAdminUser={id:"phone-admin"} as never;next();}},async baseUrl=>{
  const changed=await request(baseUrl,"/people/demo-person-1",{method:"PATCH",body:{revision:1,phoneMethods:methods}});
  assert.equal(changed.status,200);assert.deepEqual(changed.body.phoneMethods,methods);assert.equal(changed.body.recordRevision,2);
  const saved=(await repository.getSnapshot()).people.find(row=>row.id==="demo-person-1")!;
  assert.deepEqual(saved.phoneMethods,methods);assert.equal(saved.phone,originalPhone);
  const stale=await request(baseUrl,"/people/demo-person-1",{method:"PATCH",body:{revision:1,phoneMethods:[]}});
  assert.equal(stale.status,409);
  for(const phoneMethods of [[{value:"1",extra:"secret"}],[{value:"1",isPrimary:true},{value:"2",isPrimary:true}],null,[{value:""}],[{id:"same",value:"1"},{id:"same",value:"2"}],Array.from({length:21},()=>({value:"1"}))]) {
   assert.equal((await request(baseUrl,"/people/demo-person-1",{method:"PATCH",body:{revision:2,phoneMethods}})).status,400);
  }
  const created=await request(baseUrl,"/people",{method:"POST",body:{id:"phone-new",firstName:"Synthetic",lastName:"Phone",phoneMethods:methods}});
  assert.equal(created.status,201);assert.deepEqual(created.body.phoneMethods,methods);
  const cleared=await request(baseUrl,"/people/demo-person-1",{method:"PATCH",body:{revision:2,phoneMethods:[]}});
  assert.equal(cleared.status,200);assert.equal(cleared.body.phoneMethods,undefined);assert.deepEqual((await repository.getSnapshot()).people.find(row=>row.id==="demo-person-1")!.phoneMethods,[]);
 });
});
