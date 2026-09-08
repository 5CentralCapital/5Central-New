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

test("unknown imported boolean values stay absent until the operator explicitly chooses", async () => {
  const { mutationPayload } = await import("./form-payload");
  for (const unknown of [undefined, null, ""]) {
    const initial = { id: "membership", revision: 1, isFinanciallyResponsible: unknown, relationship: "old" };
    assert.deepEqual(mutationPayload("save-household-membership", { ...initial, isFinanciallyResponsible: false, relationship: "new" }, initial), { id: "membership", revision: 1, relationship: "new" });
    for (const chosen of [true, false]) assert.equal(mutationPayload("save-household-membership", { ...initial, isFinanciallyResponsible: chosen }, initial, new Set(["isFinanciallyResponsible"])).isFinanciallyResponsible, chosen);
    const lease = { id: "lease", revision: 1, monthToMonth: unknown };
    assert.deepEqual(mutationPayload("save-lease-term", { ...lease, monthToMonth: false }, lease), { id: "lease", revision: 1 });
    assert.equal(mutationPayload("save-lease-term", { ...lease, monthToMonth: false }, lease, new Set(["monthToMonth"])).monthToMonth, false);
  }
});
test("section creation controls use the correct entity and omit report creation",async()=>{
 const {sectionCreateAction}=await import("./ui");assert.equal(sectionCreateAction("leases")?.action,"save-lease-term");assert.equal(sectionCreateAction("leases")?.label,"Add lease");for(const section of ["reports","rent-roll","documents","applicants"])assert.equal(sectionCreateAction(section),undefined);
});
test("only local read-only transport is blocked; real transport can save synthetic data",async()=>{
 const {assertWritableRentOpsTransport}=await import("./api");assert.throws(()=>assertWritableRentOpsTransport(true),/Read-only preview. No records were saved/);assert.doesNotThrow(()=>assertWritableRentOpsTransport(false));
 let message="";let conflict=false;try{assertWritableRentOpsTransport(true);}catch(error){handleRentOpsMutationError(error,()=>{conflict=true;},value=>{message=value;});}assert.match(message,/No records were saved/);assert.equal(conflict,false);
});
