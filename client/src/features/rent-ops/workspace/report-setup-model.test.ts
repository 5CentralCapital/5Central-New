import assert from "node:assert/strict";
import test from "node:test";
import type { ReportRow, ViewFilters } from "../types";
import {
  applyReportSetupLocalFilters,
  createInitialReportSetup,
  normalizeReportSetup,
  reportSetupQueryFilters,
  reportSetupToUrlValue,
  reportSetupFromUrlValue,
  updateReportSetup,
  validateReportSetup,
  type ReportSetupDirectory,
} from "./report-setup-model";

const directory: ReportSetupDirectory = {
  properties: [
    { id: "p1", name: "Active property", state: "active" },
    { id: "p2", name: "Inactive property", state: "inactive" },
  ],
  units: [
    { id: "u1", propertyId: "p1", unitNumber: "101" },
    { id: "u2", propertyId: "p2", unitNumber: "201" },
  ],
  people: [
    { id: "person-1", firstName: "One" },
    { id: "person-2", firstName: "Two" },
    { id: "account-only", firstName: "Account" },
  ],
  tenancies: [
    { id: "tenancy-1", propertyId: "p1", unitId: "u1", primaryPersonId: "person-1", status: "current" },
    { id: "tenancy-2", propertyId: "p2", unitId: "u2", primaryPersonId: "person-2", status: "former" },
  ],
};

const filters: ViewFilters = {
  propertyScope: "active",
  propertyId: "all",
  propertyIds: [],
  asOfDate: "2026-08-15",
  status: "vacant",
  search: "",
};

test("report setup uses metadata defaults and validates the property scope field independently", () => {
  const rentRoll = createInitialReportSetup("rent-roll", filters, directory);
  assert.deepEqual(rentRoll.values.occupancy, ["current"]);
  assert.equal(rentRoll.values.balanceStatus, "all");
  assert.equal(reportSetupQueryFilters("rent-roll", rentRoll).propertyScope, "active");
  assert.equal(validateReportSetup("rent-roll", { ...rentRoll, propertyIds: ["p1"] }), undefined);

  const occupancy = createInitialReportSetup("occupancy", filters, directory);
  assert.deepEqual(occupancy.values.occupancy, ["vacant"]);
  const delinquency = createInitialReportSetup("delinquency", filters, directory);
  assert.equal(delinquency.values.balanceStatus, "due");
});

test("changing properties clears unit, tenancy, and tenant references outside the new scope", () => {
  const initial = createInitialReportSetup("collected-income", { ...filters, propertyScope: "all" }, directory);
  const withBothProperties = updateReportSetup("collected-income", initial, {
    propertyIds: ["p1", "p2"],
    values: { ...initial.values, unitId: "u2", tenancyId: "tenancy-2", personId: "person-2" },
  }, directory);
  const narrowed = updateReportSetup("collected-income", withBothProperties, { propertyIds: ["p1"] }, directory);
  assert.equal(narrowed.values.unitId, "");
  assert.equal(narrowed.values.tenancyId, "");
  assert.equal(narrowed.values.personId, "");

  const accountOnly = normalizeReportSetup("collected-income", {
    ...initial,
    values: { ...initial.values, personId: "account-only" },
  }, directory);
  assert.equal(accountOnly.values.personId, "account-only");
});

test("report query carries the applied references, range, and rent roll search", () => {
  const state = updateReportSetup("collected-income", createInitialReportSetup("collected-income", { ...filters, propertyScope: "all" }, directory), {
    propertyIds: ["p1"],
    fromDate: "2026-08-01",
    toDate: "2026-08-15",
    values: {
      tenantStatus: "former",
      unitId: "u1",
      tenancyId: "tenancy-1",
      personId: "person-1",
      search: "one",
    },
  }, directory);
  const query = reportSetupQueryFilters("collected-income", state);
  assert.deepEqual(query.propertyIds, ["p1"]);
  assert.equal(query.unitId, "u1");
  assert.equal(query.tenancyId, "tenancy-1");
  assert.equal(query.personId, "person-1");
  assert.equal(query.fromDate, "2026-08-01");
  assert.equal(query.toDate, "2026-08-15");
  assert.equal(query.search, "one");
  assert.equal(query.tenantStatus, "former");

  const rentRoll = updateReportSetup("rent-roll", createInitialReportSetup("rent-roll", filters, directory), {
    values: { occupancy: ["current"], search: "101" },
  }, directory);
  assert.equal(reportSetupQueryFilters("rent-roll", rentRoll).search, "101");
});

test("report setup URL round trip retains selections and neutral local filtering preserves opening balances", () => {
  const state = updateReportSetup("tenant-ledger", createInitialReportSetup("tenant-ledger", { ...filters, propertyScope: "all" }, directory), {
    propertyIds: ["p1"],
    fromDate: "2026-08-01",
    toDate: "2026-08-15",
    values: { tenantStatus: "current", unitId: "u1", tenancyId: "tenancy-1", personId: "person-1" },
  }, directory);
  const restored = reportSetupFromUrlValue("tenant-ledger", reportSetupToUrlValue(state), state, directory);
  assert.deepEqual(restored, state);

  const openingBalance = { rowType: "opening_balance", transaction: { personId: "person-1" } } as unknown as ReportRow;
  assert.equal(applyReportSetupLocalFilters([openingBalance], "tenant-ledger", state).length, 1);
});
