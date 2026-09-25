import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRentManagerExport } from "./normalizer";
import { mapRentManagerExport } from "../import/rm-mapper";

// Synthetic RM-shaped history rows only.
function normalizedActivities() {
  const result = normalizeRentManagerExport({
    tenants: [{ TenantID: 201, FirstName: "Synthetic", LastName: "Resident" }],
    histories: [
      { HistoryID: 1, sourceCollection: "tenantHistory.current", _parentSourceId: "201", parentSourceId: "201", HistoryDate: "2026-08-01T12:00:00", Note: "Synthetic call body", HistoryType: "Call", CreateUserID: 7, CreateUser: { Name: "Synthetic Staff" } },
      { HistoryID: 4, sourceCollection: "tenantHistory.current", _parentSourceId: "201", parentSourceId: "201", HistoryDate: "2026-08-04T12:00:00", CreateUserID: 9 },
    ],
    notes: [{ HistoryNoteID: 2, sourceCollection: "historyNotes", ParentType: "Tenant", ParentID: 201, HistoryDate: "2026-08-02T12:00:00", Note: "Synthetic note body" }],
    communications: [{ OutgoingTextID: 3, sourceCollection: "outgoingTexts", ParentType: "Tenant", ParentID: 201, Date: "2026-08-03T12:00:00", Message: "Synthetic text body" }],
  } as never);
  return (result.input.activities ?? []) as Record<string, unknown>[];
}

test("K7: RM history bodies, kinds and embedded author names are mapped from source fields", () => {
  const rows = normalizedActivities();
  const byId = (field: string, id: number) => rows.find((row) => row[field] === id)!;
  const call = byId("HistoryID", 1);
  assert.equal(call.detail, "Synthetic call body", "RM History carries its body as Note");
  assert.equal(call.activityType, "call");
  assert.equal(call.actor, "Synthetic Staff");
  const note = byId("HistoryNoteID", 2);
  assert.equal(note.detail, "Synthetic note body");
  assert.equal(note.activityType, "note", "the HistoryNotes collection identifies a note");
  const text = byId("OutgoingTextID", 3);
  assert.equal(text.detail, "Synthetic text body");
  assert.equal(text.activityType, "text");
});

test("K7: absent facts stay absent; a numeric user ID is never an author", () => {
  const bare = normalizedActivities().find((row) => row.HistoryID === 4)!;
  assert.equal(bare.actor, undefined);
  assert.equal(bare.detail, undefined);
  assert.equal(bare.summary, undefined);
  assert.equal(bare.activityType, undefined, "a tenant History row without a type field has no inferred kind");
});

test("K7: the mapper keeps mapped type, body and author and never uses an ID as the author", () => {
  const input = {
    properties: [{ entityType: "property", sourceId: "p1", name: "Synthetic Property", slug: "synthetic-property", address: "1 Example Way", city: "Sampleton", state: "ZZ", postalCode: "00001" }],
    tenants: [{ entityType: "tenant", sourceId: "t1", name: "Synthetic Resident" }],
    activities: [
      { entityType: "activity", sourceId: "act-mapped", tenantId: "t1", activityType: "call", actor: "Synthetic Staff", detail: "Synthetic body", occurredAt: "2026-08-03T12:00:00.000Z" },
      { entityType: "activity", sourceId: "act-raw", tenantId: "t1", Subject: "Synthetic subject", Note: "Synthetic raw body", createUserId: "42", occurredAt: "2026-08-04T12:00:00.000Z" },
    ],
  };
  const { snapshot } = mapRentManagerExport(input as never, { now: new Date("2026-08-16T12:00:00.000Z") });
  const mapped = snapshot.activityEvents.find((row) => row.source?.sourceId === "act-mapped")!;
  assert.equal(mapped.type, "call");
  assert.equal(mapped.actor, "Synthetic Staff");
  assert.equal(mapped.detail, "Synthetic body");
  const raw = snapshot.activityEvents.find((row) => row.source?.sourceId === "act-raw")!;
  assert.equal(raw.summary, "Synthetic subject");
  assert.equal(raw.detail, "Synthetic raw body");
  assert.notEqual(raw.actor, "42");
  assert.equal((raw as { actorKnowledge?: string }).actorKnowledge, "unknown");
});
