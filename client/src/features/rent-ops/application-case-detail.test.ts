import assert from "node:assert/strict";
import test from "node:test";

import { decodeRentOpsApplicationDetail, decodeRentOpsApplicationHistoryCase, loadRentOpsApplication } from "./api";
import {
  applicationCaseFact,
  applicationHistorySectionState,
  applicationCaseSectionState,
  applicationDocumentDownloadable,
  restoreApplicationCaseFocus,
} from "./application-case-detail-model";
import type { AdminApplicationDetailView, AdminApplicationHistoryCaseView } from "./types";

function detailFixture(overrides: Partial<AdminApplicationDetailView> = {}): AdminApplicationDetailView {
  return {
    id: "application:one",
    status: "under_review",
    firstName: "Sample",
    lastName: "Applicant",
    email: "sample@example.test",
    householdMembers: [],
    requirements: [],
    documents: [],
    ...overrides,
  };
}

function historyFixture(overrides: Partial<AdminApplicationHistoryCaseView> = {}): AdminApplicationHistoryCaseView {
  return {
    application: { id: "application:one", firstName: "Historical", status: "submitted", statusKnowledge: "source" },
    interests: [],
    participants: [],
    requirements: [],
    answers: [],
    documents: [],
    activities: [],
    blockers: [],
    unknownRestricted: {
      restrictedAnswerCount: 0,
      unmappedAnswerCount: 0,
      missingAnswerApplications: 0,
      metadataOnlyDocumentCount: 0,
      unavailableDocumentCount: 0,
      unlinkedActivityCount: 0,
      unlinkedInterestCount: 0,
    },
    ...overrides,
  };
}

test("application detail loads only when the target case is opened", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(detailFixture({ history: historyFixture() })), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const loaded = await loadRentOpsApplication("application:one");
    assert.deepEqual(calls, ["/api/rent-ops/applications/application%3Aone"]);
    assert.equal(loaded.id, "application:one");
    assert.deepEqual(loaded.requirements, []);
    assert.equal(loaded.history?.application?.id, "application:one");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("application detail decoder fails closed on unknown and forbidden fields", () => {
  for (const key of ["unexpected", "source", "raw", "ssn", "dob", "token", "storageKey", "hash"] as const) {
    const polluted = detailFixture() as unknown as Record<string, unknown>;
    polluted[key] = "forbidden-canary";
    assert.throws(() => decodeRentOpsApplicationDetail(polluted), /invalid response/);
  }

  const nestedPolluted = detailFixture({ requirements: [{ id: "requirement:one", label: "Income", status: "requested", unexpected: "canary" } as never] });
  assert.throws(() => decodeRentOpsApplicationDetail(nestedPolluted), /invalid response/);
});

test("historical case decoder is independently strict and never admits raw answer or document fields", () => {
  const fixture = historyFixture({
    answers: [{ valueType: "text", valueKnowledge: "restricted", fieldLinkKnowledge: "exact" }],
    documents: [{ type: "identity", typeKnowledge: "source", state: "received", stateKnowledge: "source", fileName: "identity.pdf", mimeType: "application/pdf", metadataSizeBytes: 42, availability: "metadata" }],
    activities: [{ type: "email", occurredAt: "2026-08-10T12:00:00.000Z", occurredAtKnowledge: "source", summaryKnowledge: "unknown" }],
    blockers: [{ code: "application_answers_missing", occurrenceCount: 1, reason: "source_rows_unusable" }],
  });
  assert.equal(decodeRentOpsApplicationHistoryCase(fixture).application?.id, "application:one");
  for (const [section, key] of [["root", "source"], ["answers", "value"], ["documents", "metadataChecksumSha256"], ["activities", "actor"], ["blockers", "applicationId"]] as const) {
    const polluted = structuredClone(fixture) as unknown as Record<string, unknown>;
    if (section === "root") polluted[key] = "forbidden-canary";
    else {
      const rows = polluted[section] as Array<Record<string, unknown>>;
      rows[0]![key] = "forbidden-canary";
    }
    assert.throws(() => decodeRentOpsApplicationHistoryCase(polluted), /invalid response/);
  }
});

test("case sections distinguish unloaded, empty, and populated states", () => {
  assert.equal(applicationCaseSectionState(undefined, "household"), "unknown");
  const empty = detailFixture({ firstName: undefined, lastName: undefined, email: undefined, phone: undefined, status: undefined, submittedOn: undefined, preferences: undefined, householdSummary: undefined, employment: undefined, voucher: undefined });
  assert.equal(applicationCaseSectionState(empty, "overview"), "unknown");
  assert.equal(applicationCaseSectionState(empty, "household"), "empty");
  assert.equal(applicationCaseSectionState(empty, "requirements"), "empty");
  assert.equal(applicationCaseSectionState(empty, "documents"), "empty");
  assert.equal(applicationCaseSectionState(detailFixture({ householdMembers: [{ id: "member:one", firstName: "Household" }] }), "household"), "ready");
});

test("historical sections distinguish full, empty, unknown, and restricted states", () => {
  const empty = historyFixture();
  assert.equal(applicationHistorySectionState(undefined, "overview"), "unknown");
  assert.equal(applicationHistorySectionState(empty, "interests"), "empty");
  assert.equal(applicationHistorySectionState(empty, "unknownRestricted"), "full");
  assert.equal(applicationHistorySectionState(historyFixture({ interests: [{ propertyId: "property:one" }] }), "interests"), "full");
  assert.equal(applicationHistorySectionState(historyFixture({ unknownRestricted: { ...empty.unknownRestricted, restrictedAnswerCount: 1 } }), "answers"), "restricted");
  assert.equal(applicationHistorySectionState(historyFixture({ unknownRestricted: { ...empty.unknownRestricted, unavailableDocumentCount: 1 } }), "documents"), "restricted");
  assert.equal(applicationHistorySectionState(historyFixture({ unknownRestricted: { ...empty.unknownRestricted, unlinkedActivityCount: 1 } }), "activities"), "unknown");
  assert.equal(applicationHistorySectionState(historyFixture({ unknownRestricted: { ...empty.unknownRestricted, unmappedAnswerCount: 1 } }), "unknownRestricted"), "restricted");
});

test("unknown facts remain safe and explicit", () => {
  assert.equal(applicationCaseFact(undefined), "Unknown");
  assert.equal(applicationCaseFact("old value", "unknown"), "Needs review");
  assert.equal(applicationCaseFact(false), "No");
});

test("document downloads require the positive verified availability gate", () => {
  assert.equal(applicationDocumentDownloadable({ id: "document:one", state: "verified", availability: "verified", downloadAvailable: true }), true);
  assert.equal(applicationDocumentDownloadable({ id: "document:one", state: "verified", availability: "metadata", downloadAvailable: true }), false);
  assert.equal(applicationDocumentDownloadable({ id: "document:one", state: "received", availability: "verified", downloadAvailable: true }), false);
  assert.equal(applicationDocumentDownloadable({ id: undefined, state: "verified", availability: "verified", downloadAvailable: true }), false);
});

test("closing a case restores focus to the card trigger", () => {
  let focused = 0;
  restoreApplicationCaseFocus({ focus: () => { focused += 1; } });
  restoreApplicationCaseFocus(undefined);
  assert.equal(focused, 1);
});

test("unknown answer type decodes as restricted metadata and rejects raw values", () => {
  const fixture = historyFixture({ answers: [{ valueType: "unknown", valueKnowledge: "restricted", fieldLinkKnowledge: "exact" }], unknownRestricted: { ...historyFixture().unknownRestricted, restrictedAnswerCount: 1 } });
  const decoded = decodeRentOpsApplicationHistoryCase(fixture);
  assert.equal(decoded.answers[0]?.valueType, "unknown");
  assert.equal(decoded.answers[0]?.valueKnowledge, "restricted");
  assert.equal(applicationHistorySectionState(decoded, "answers"), "full");
  const polluted = structuredClone(fixture);
  Object.assign(polluted.answers[0]!, { value: "RESTRICTED_CANARY", InputFieldType: "None" });
  assert.throws(() => decodeRentOpsApplicationHistoryCase(polluted), /invalid response/);
});
