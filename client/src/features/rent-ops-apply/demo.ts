import type { ApplicantHouseholdMemberView, ApplicantPublicView, ApplicantDocumentView } from "./types";

export const APPLY_DEMO_TOKEN = "demo-resume-token-7f3a";

const demoApplication: ApplicantPublicView = {
  id: "demo-application-portal",
  status: "draft",
  email: "applicant@example.test",
  firstName: "Demo",
  lastName: "Applicant",
  phone: "555-0100",
  certificationAcceptedOn: undefined,
  householdSummary: { adults: 1, children: 0, totalOccupants: 1 },
  preferences: { desiredLeaseMonths: 12, bedrooms: 1 },
  voucher: { hasVoucher: false },
  requirements: [],
  householdMembers: [],
  documents: [],
};

let memoryApplication: ApplicantPublicView = structuredClone(demoApplication);

function localIsoDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function demoStartApplication(input: { email: string; firstName: string; lastName: string; phone: string; currentAddress: string }): { application: ApplicantPublicView; resumeToken: string; expiresAt: string } {
  memoryApplication = { ...structuredClone(demoApplication), email: input.email, firstName: input.firstName, lastName: input.lastName, phone: input.phone, rentalHistory: { currentAddress: input.currentAddress } };
  return { application: structuredClone(memoryApplication), resumeToken: APPLY_DEMO_TOKEN, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
}

export function demoResumeApplication(token: string): ApplicantPublicView {
  if (token !== APPLY_DEMO_TOKEN) throw new Error("That secure resume link is invalid or expired.");
  return structuredClone(memoryApplication);
}

export function demoSaveApplication(input: Partial<ApplicantPublicView>): ApplicantPublicView {
  memoryApplication = { ...memoryApplication, ...input };
  return structuredClone(memoryApplication);
}

export function demoAddHouseholdMember(member: ApplicantHouseholdMemberView): ApplicantPublicView {
  const householdMembers = [...(memoryApplication.householdMembers ?? []), member];
  return demoSaveApplication({ householdMembers });
}

export function demoAddDocument(document: ApplicantDocumentView): ApplicantPublicView {
  return demoSaveApplication({ documents: [...memoryApplication.documents, document] });
}

export function demoCertifyApplication(): ApplicantPublicView {
  return demoSaveApplication({ certificationAcceptedOn: localIsoDate() });
}

export function demoSubmitApplication(): ApplicantPublicView {
  if (memoryApplication.status === "submitted" || memoryApplication.status === "under_review") return structuredClone(memoryApplication);
  return demoSaveApplication({ status: "submitted", submittedOn: localIsoDate() });
}
