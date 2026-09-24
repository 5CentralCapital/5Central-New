import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationGroupCounts,
  applicationsInPropertySelection,
  applicationStatusGroup,
  applicationStatusTone,
  filterApplicationsByGroup,
} from "./applications-view-model";
import { displayPersonName } from "../../../lib/rent-ops-formatters";

test("status groups use stored statuses without changing them", () => {
  assert.equal(applicationStatusGroup({ status: "submitted" }), "needs_action");
  assert.equal(applicationStatusGroup({ status: "under_review" }), "needs_action");
  assert.equal(applicationStatusGroup({ status: "approved" }), "needs_action", "An approval awaiting conversion still needs the manager");
  assert.equal(applicationStatusGroup({ status: "approved", convertedTenancyId: "t" }), "complete");
  assert.equal(applicationStatusGroup({ status: "missing_information" }), "in_progress");
  assert.equal(applicationStatusGroup({ status: "draft" }), "in_progress");
  assert.equal(applicationStatusGroup({ status: "declined" }), "complete");
  assert.equal(applicationStatusGroup({ status: "source_status" }), undefined);
  const rows = [{ status: "submitted" }, { status: "draft" }, { status: "withdrawn" }, { status: undefined }];
  assert.deepEqual(applicationGroupCounts(rows), { all: 4, needs_action: 1, in_progress: 1, complete: 1 });
  assert.deepEqual(filterApplicationsByGroup(rows, "all"), rows);
  assert.deepEqual(filterApplicationsByGroup(rows, "complete"), [{ status: "withdrawn" }]);
  assert.equal(rows[0]?.status, "submitted");
});

test("status pills keep uncertain statuses neutral", () => {
  assert.equal(applicationStatusTone("approved"), "success");
  assert.equal(applicationStatusTone("declined"), "error");
  assert.equal(applicationStatusTone("approved", "inferred"), "unknown");
  assert.equal(applicationStatusTone("submitted"), undefined);
});

test("several chosen properties scope the register", () => {
  const rows = [{ id: "a", propertyId: "p1" }, { id: "b", propertyId: "p2" }, { id: "c" }];
  assert.deepEqual(applicationsInPropertySelection(rows, ["p1", "p2"]).map((row) => row.id), ["a", "b"]);
  assert.deepEqual(applicationsInPropertySelection(rows, undefined).map((row) => row.id), ["a", "b", "c"]);
});

test("applicant names display in title case while stored values stay as typed", () => {
  const stored = "paula datlow";
  assert.equal(displayPersonName(stored), "Paula Datlow");
  assert.equal(stored, "paula datlow");
  assert.equal(displayPersonName("Mary McElwee"), "Mary McElwee");
});
