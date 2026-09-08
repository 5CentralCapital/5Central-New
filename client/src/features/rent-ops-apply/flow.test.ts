import assert from "node:assert/strict";
import test from "node:test";

import { centsFromDollars, draftFromApplication, mergeApplicantHouseholdMember, mergeApplicationDraft, normalizeApplicantHouseholdMember, parseResumeToken, saveInputFromDraft, validateStart } from "./flow";

test("start requires the RM-guided contact and current-address fields", () => {
  assert.equal(validateStart({ firstName: "Sample", lastName: "Applicant", email: "sample@example.test", phone: "", currentAddress: "1 Example Way" }), "Enter a phone number.");
  assert.equal(validateStart({ firstName: "Sample", lastName: "Applicant", email: "sample@example.test", phone: "555-0100", currentAddress: "1 Example Way" }), null);
});

test("application draft round-trip omits empty emergency contacts and keeps cents", () => {
  const draft = draftFromApplication({ id: "application:test", status: "draft", email: "sample@example.test", firstName: "Sample", lastName: "Applicant", householdMembers: [], requirements: [], documents: [] });
  draft.employment.monthlyIncomeCents = centsFromDollars("1234.56");
  const input = saveInputFromDraft(draft);
  assert.equal(input.employment?.monthlyIncomeCents, 123456);
  assert.equal(input.emergencyContact, undefined);
});

test("resume links use fragments and raw tokens must have the expected shape", () => {
  const token = "A".repeat(48);
  assert.equal(parseResumeToken(`https://apply.example.test/apply#resume=${token}`), token);
  assert.equal(parseResumeToken(token), token);
  assert.equal(parseResumeToken(`https://apply.example.test/apply?resume=${token}`), null);
  assert.equal(parseResumeToken(`https://apply.example.test/apply?token=${token}#other=value`), null);
  assert.equal(parseResumeToken("short-secret"), null);
});

test("applicant money fields reject more than two decimal places", () => {
  assert.equal(centsFromDollars("1250.00"), 125000);
  assert.equal(centsFromDollars("1250.001"), undefined);
});

test("rapid nested field updates merge instead of discarding earlier applicant values", () => {
  const initial = draftFromApplication({ id: "application:test", status: "draft", email: "sample@example.test", firstName: "Sample", lastName: "Applicant", householdMembers: [], requirements: [], documents: [] });
  const withDate = mergeApplicationDraft(initial, { preferences: { desiredMoveInOn: "2026-10-01" } });
  const withIncome = mergeApplicationDraft(withDate, { preferences: { maxRentCents: 150000 }, employment: { employerName: "Example Employer" } });
  const final = mergeApplicationDraft(withIncome, { employment: { jobTitle: "Tester" }, emergencyContact: { name: "Emergency Contact" } });
  assert.equal(final.preferences.desiredMoveInOn, "2026-10-01");
  assert.equal(final.preferences.maxRentCents, 150000);
  assert.equal(final.employment.employerName, "Example Employer");
  assert.equal(final.employment.jobTitle, "Tester");
  assert.equal(final.emergencyContact.name, "Emergency Contact");
});

test("rapid household-member field updates retain every controlled value", () => {
  const initial = { firstName: "", lastName: "", relationship: "", email: "", phone: "", isMinor: false };
  const final = [
    { firstName: "Taylor" },
    { lastName: "Resident" },
    { relationship: "Child" },
    { isMinor: true },
  ].reduce((current, patch) => mergeApplicantHouseholdMember(current, patch), initial);
  assert.deepEqual(final, { firstName: "Taylor", lastName: "Resident", relationship: "Child", email: "", phone: "", isMinor: true });
});

test("household-member payload normalization omits blank optional fields", () => {
  assert.deepEqual(normalizeApplicantHouseholdMember({ firstName: " Taylor ", lastName: " Resident ", relationship: " ", email: "", phone: "  ", isMinor: true }), {
    firstName: "Taylor",
    lastName: "Resident",
    isMinor: true,
  });
  assert.deepEqual(normalizeApplicantHouseholdMember({ firstName: "Taylor", lastName: "Resident", relationship: "Child", email: " child@example.test ", phone: " 555-0100 ", isMinor: false }), {
    firstName: "Taylor",
    lastName: "Resident",
    relationship: "Child",
    email: "child@example.test",
    phone: "555-0100",
    isMinor: false,
  });
});

test("rapid preference updates are present in the immediate save payload", () => {
  const initial = draftFromApplication({ id: "application:test", status: "draft", email: "sample@example.test", firstName: "Sample", lastName: "Applicant", householdMembers: [], requirements: [], documents: [] });
  const final = [
    { propertyId: "property:harbor" },
    { unitId: "unit:harbor:1" },
    { preferences: { desiredMoveInOn: "2026-09-20" } },
    { preferences: { desiredLeaseMonths: 12 } },
    { preferences: { maxRentCents: 150000 } },
    { preferences: { bedrooms: 1 } },
  ].reduce((current, patch) => mergeApplicationDraft(current, patch), initial);
  const input = saveInputFromDraft(final);
  assert.equal(input.propertyId, "property:harbor");
  assert.equal(input.unitId, "unit:harbor:1");
  assert.equal(input.preferences?.desiredMoveInOn, "2026-09-20");
  assert.equal(input.preferences?.desiredLeaseMonths, 12);
  assert.equal(input.preferences?.maxRentCents, 150000);
  assert.equal(input.preferences?.bedrooms, 1);
});
