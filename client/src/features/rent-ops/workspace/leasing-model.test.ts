import assert from "node:assert/strict";
import test from "node:test";

import type { AdminApplicationView, AdminDocumentView, AdminSnapshot } from "../types";
import {
  applicationDisplayName,
  applicationStatusOptions,
  documentAvailabilityLabel,
  filterApplications,
  filterActivities,
  filterDocuments,
  linkedRecordLabel,
  sortApplicationsByDate,
} from "./leasing-model";

const property = { id: "property:active", name: "Active Homes", state: "active" };
const archivedProperty = { id: "property:archived", name: "Archived Homes", state: "archived" };
const unit = { id: "unit:one", propertyId: property.id, unitNumber: "1A" };
const snapshot = {
  snapshot: {
    properties: [property, archivedProperty],
    units: [unit],
    people: [{ id: "person:one", firstName: "Alex", lastName: "Resident" }],
    tenancies: [{ id: "tenancy:one", propertyId: property.id, unitId: unit.id, status: "current" }],
  },
  applicants: [],
} as unknown as AdminSnapshot;

function application(overrides: Partial<AdminApplicationView> = {}): AdminApplicationView {
  return {
    id: "application:one",
    firstName: "Taylor",
    lastName: "Applicant",
    status: "under_review",
    propertyId: property.id,
    unitId: unit.id,
    submittedOn: "2026-09-10",
    ...overrides,
  };
}

test("status options follow the shared manual transition contract", () => {
  assert.deepEqual(applicationStatusOptions("under_review"), ["under_review", "approved", "missing_information", "declined", "withdrawn"]);
  assert.deepEqual(applicationStatusOptions("approved"), ["approved", "withdrawn"]);
  assert.deepEqual(applicationStatusOptions(undefined), []);
  assert.deepEqual(applicationStatusOptions("source_status"), ["source_status"]);
});

test("application filtering preserves separate cases with the same applicant name", () => {
  const rows = [
    application({ id: "application:first", email: "same@example.test" }),
    application({ id: "application:second", email: "same@example.test", submittedOn: "2026-09-03" }),
    application({ id: "application:archived", propertyId: archivedProperty.id }),
  ];
  const filtered = filterApplications(rows, snapshot, { propertyScope: "active", propertyId: "all", status: "all", search: "same@example.test" });
  assert.deepEqual(filtered.map((row) => row.id), ["application:first", "application:second"]);
  assert.equal(applicationDisplayName(filtered[0]!), "Taylor Applicant");
});

test("application filters support exact status, unit, and submitted date bounds", () => {
  const rows = [
    application({ id: "application:one", status: "under_review", submittedOn: "2026-09-10" }),
    application({ id: "application:two", status: "missing_information", submittedOn: "2026-09-01" }),
  ];
  const filtered = filterApplications(rows, snapshot, {
    propertyScope: "active",
    propertyId: property.id,
    unitId: unit.id,
    status: "under review",
    search: "",
    fromDate: "2026-09-09",
    toDate: "2026-09-11",
  });
  assert.deepEqual(filtered.map((row) => row.id), ["application:one"]);
});

test("documents keep metadata-only records separate from verified downloads", () => {
  const verified: AdminDocumentView = { id: "document:verified", state: "verified", availability: "verified", downloadAvailable: true, fileName: "verified.pdf", propertyId: property.id };
  const metadata: AdminDocumentView = { id: "document:metadata", state: "verified", availability: "metadata", downloadAvailable: true, fileName: "metadata.pdf", propertyId: property.id };
  assert.equal(documentAvailabilityLabel(verified), "Verified secure file");
  assert.equal(documentAvailabilityLabel(metadata), "Metadata only · file unavailable");
  const filtered = filterDocuments([verified, metadata], snapshot, { propertyScope: "active", propertyId: property.id, status: "all", search: "metadata" });
  assert.deepEqual(filtered.map((record) => record.id), ["document:metadata"]);
});

test("unknown document type can be filtered without inventing a type", () => {
  const record: AdminDocumentView = { id: "document:unknown", propertyId: property.id, downloadAvailable: false };
  assert.deepEqual(filterDocuments([record], snapshot, { propertyScope: "active", propertyId: property.id, type: "unknown", status: "all", search: "" }).map((item) => item.id), ["document:unknown"]);
});

test("linked records use available human labels and retain unresolved links", () => {
  assert.equal(linkedRecordLabel(snapshot, { propertyId: property.id, unitId: unit.id, personId: "person:one" }), "Alex Resident · Active Homes · 1A");
  assert.equal(linkedRecordLabel(snapshot, { applicationId: "application:missing" }), "Application needs review");
  assert.equal(linkedRecordLabel(snapshot, { propertyId: "property:missing" }), "Property needs review");
});

test("application sorting is newest first without merging rows", () => {
  const rows = [application({ id: "application:old", submittedOn: "2026-09-01" }), application({ id: "application:new", submittedOn: "2026-09-11" })];
  assert.deepEqual(sortApplicationsByDate(rows).map((row) => row.id), ["application:new", "application:old"]);
});


test("active scope and selected property are both enforced on unscoped collections", () => {
  const archivedApplication = application({ propertyId: archivedProperty.id });
  const filters = { propertyScope: "active" as const, propertyId: archivedProperty.id };
  assert.deepEqual(filterApplications([archivedApplication], snapshot, filters), []);
  assert.deepEqual(filterDocuments([{ propertyId: archivedProperty.id }], snapshot, filters), []);
  assert.deepEqual(filterActivities([{ propertyId: archivedProperty.id }], snapshot, filters), []);
  assert.equal(filterApplications([archivedApplication], snapshot, { ...filters, propertyScope: "all" }).length, 1);
});

test("document and activity scope resolves unit and tenancy links", () => {
  const filters = { propertyScope: "active" as const, propertyId: property.id, unitId: unit.id };
  assert.equal(filterDocuments([{ unitId: unit.id }], snapshot, filters).length, 1);
  assert.equal(filterActivities([{ tenancyId: "tenancy:one" }], snapshot, filters).length, 1);
  assert.deepEqual(filterDocuments([{ propertyId: archivedProperty.id }], snapshot, filters), []);
});
