import assert from "node:assert/strict";
import test from "node:test";
import { RentOpsApiError } from "./api";
import { RENT_OPS_QUICK_ADD_ACTIONS } from "./form-payload";
import { handleRentOpsMutationError, refreshRentOpsAfterConflict, RENT_OPS_CONFLICT_NOTICE, sparseEditValue } from "./ui";

test("sparse edit defaults do not fabricate unknown checkbox facts", () => {
  assert.equal(sparseEditValue(false, undefined, false, true), undefined);
  assert.equal(sparseEditValue(true, undefined, false, true), true);
  assert.equal(sparseEditValue("", "2026-01-01", true, true), null);
});

test("the browser conflict path closes stale editing state and reloads the snapshot", () => {
  const events: string[] = [];
  let notice = "";
  refreshRentOpsAfterConflict({
    closeEditor: () => events.push("close"),
    clearEditor: () => events.push("clear"),
    showNotice: (message) => { notice = message; },
    reload: () => { events.push("reload"); },
  });
  assert.deepEqual(events, ["close", "clear", "reload"]);
  assert.equal(notice, RENT_OPS_CONFLICT_NOTICE);
});

test("the action dialog routes stale API errors into the refresh callback", () => {
  let refreshed = 0;
  let displayedError = "";
  handleRentOpsMutationError(new RentOpsApiError("conflict", 409), () => { refreshed += 1; }, (message) => { displayedError = message; });
  assert.equal(refreshed, 1);
  assert.equal(displayedError, "");
});

test("quick-add UI does not offer native HAP creation", () => {
  assert.equal(RENT_OPS_QUICK_ADD_ACTIONS.includes("save-subsidy-contract"), false);
});
