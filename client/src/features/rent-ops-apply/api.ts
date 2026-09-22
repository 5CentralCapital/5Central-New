import type {
  ApplicantHouseholdMemberInput,
  ApplicantPublicView,
  ApplicantSaveInput,
  ApplicantStartInput,
  ApplicantDocumentView,
  ApplicantHouseholdMemberView,
  ApplicantRequirementView,
  ApplicationPreferences,
  EmergencyContact,
  EmploymentInfo,
  HouseholdSummary,
  PetInfo,
  RentalHistory,
  VehicleInfo,
  VoucherInfo,
} from "./types";
import {
  APPLY_DEMO_TOKEN,
  demoAddHouseholdMember,
  demoCertifyApplication,
  demoResumeApplication,
  demoSaveApplication,
  demoStartApplication,
  demoSubmitApplication,
} from "./demo";

export const APPLY_DEMO_ALLOWED = import.meta.env?.VITE_RENT_OPS_APPLY_DEMO === "true"
  && import.meta.env?.VITE_RENT_OPS_LOCAL_SYNTHETIC_BUILD === "true";

export class ApplicantPublicError extends Error {
  readonly kind: "invalid-resume" | "request";

  constructor(kind: "invalid-resume" | "request", message: string) {
    super(message);
    this.name = "ApplicantPublicError";
    this.kind = kind;
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApplicantPublicError("request", "We couldn't reach the application service. Try again.");
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 401 || response.status === 403) {
      throw new ApplicantPublicError("invalid-resume", "That secure resume link is invalid or expired.");
    }
    let code: string | undefined;
    try {
      const body = await response.clone().json() as unknown;
      const candidate = body && typeof body === "object" ? (body as Record<string, unknown>).code : undefined;
      if (typeof candidate === "string") code = candidate;
    } catch { /* keep the generic response */ }
    if (code === "verified_upload_required") throw new ApplicantPublicError("request", "Secure document upload is not available yet. The property team will tell you how to provide this document.");
    throw new ApplicantPublicError("request", "We couldn't save that update. Try again.");
  }
  try {
    return await response.json();
  } catch {
    throw new ApplicantPublicError("request", "The application service returned an invalid response.");
  }
}

function applicationFrom(payload: unknown): ApplicantPublicView {
  const envelope = isRecord(payload) ? payload : {};
  const application = isRecord(envelope.application) ? envelope.application : isRecord(envelope.data) ? envelope.data : envelope;
  const id = requiredText(application, "id");
  const status = requiredText(application, "status");
  const email = requiredText(application, "email");
  const firstName = requiredText(application, "firstName");
  const lastName = requiredText(application, "lastName");
  const householdMembers = requiredArray(application.householdMembers, "household members").flatMap(parseHouseholdMember);
  const requirements = requiredArray(application.requirements, "requirements").flatMap(parseRequirement);
  const documents = requiredArray(application.documents, "documents").flatMap(parseDocument);
  return {
    id,
    status,
    email,
    firstName,
    lastName,
    phone: optionalText(application, "phone"),
    propertyId: optionalText(application, "propertyId"),
    unitId: optionalText(application, "unitId"),
    submittedOn: optionalText(application, "submittedOn"),
    certificationAcceptedOn: optionalText(application, "certificationAcceptedOn"),
    rentalHistory: parseRentalHistory(application.rentalHistory),
    employment: parseEmployment(application.employment),
    householdSummary: parseHouseholdSummary(application.householdSummary),
    preferences: parsePreferences(application.preferences),
    voucher: parseVoucher(application.voucher),
    pets: parsePets(application.pets),
    vehicles: parseVehicles(application.vehicles),
    emergencyContact: parseEmergencyContact(application.emergencyContact),
    householdMembers,
    requirements,
    documents,
  };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(input: JsonRecord, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value) throw new ApplicantPublicError("request", "The application service returned an invalid record.");
  return value;
}

function optionalText(input: JsonRecord, field: string): string | undefined {
  return typeof input[field] === "string" && input[field] ? input[field] as string : undefined;
}

function optionalNumber(input: JsonRecord, field: string): number | undefined {
  return typeof input[field] === "number" && Number.isFinite(input[field]) ? input[field] as number : undefined;
}

function optionalBoolean(input: JsonRecord, field: string): boolean | undefined {
  return typeof input[field] === "boolean" ? input[field] as boolean : undefined;
}

function nestedRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new ApplicantPublicError("request", `The application service returned no ${label}.`);
  return value;
}

function parseRentalHistory(value: unknown): RentalHistory | undefined {
  const input = nestedRecord(value); if (!input) return undefined;
  return { currentAddress: optionalText(input, "currentAddress"), priorAddress: optionalText(input, "priorAddress"), landlordName: optionalText(input, "landlordName"), landlordContact: optionalText(input, "landlordContact"), reasonForMoving: optionalText(input, "reasonForMoving") };
}

function parseEmployment(value: unknown): EmploymentInfo | undefined {
  const input = nestedRecord(value); if (!input) return undefined;
  return { employerName: optionalText(input, "employerName"), jobTitle: optionalText(input, "jobTitle"), monthlyIncomeCents: optionalNumber(input, "monthlyIncomeCents"), employmentStartOn: optionalText(input, "employmentStartOn") };
}

function parseHouseholdSummary(value: unknown): HouseholdSummary | undefined {
  const input = nestedRecord(value); if (!input) return undefined;
  const adults = optionalNumber(input, "adults"); const children = optionalNumber(input, "children"); const totalOccupants = optionalNumber(input, "totalOccupants");
  return adults === undefined || children === undefined || totalOccupants === undefined ? undefined : { adults, children, totalOccupants };
}

function parsePreferences(value: unknown): ApplicationPreferences | undefined {
  const input = nestedRecord(value); if (!input) return undefined;
  return { desiredMoveInOn: optionalText(input, "desiredMoveInOn"), desiredLeaseMonths: optionalNumber(input, "desiredLeaseMonths"), maxRentCents: optionalNumber(input, "maxRentCents"), bedrooms: optionalNumber(input, "bedrooms") };
}

function parseVoucher(value: unknown): VoucherInfo | undefined {
  const input = nestedRecord(value); if (!input) return undefined;
  const hasVoucher = optionalBoolean(input, "hasVoucher");
  return hasVoucher === undefined ? undefined : { hasVoucher, agencyName: optionalText(input, "agencyName"), caseNumber: optionalText(input, "caseNumber"), tenantPortionCents: optionalNumber(input, "tenantPortionCents") };
}

function parsePets(value: unknown): PetInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => { const input = nestedRecord(entry); const type = input && optionalText(input, "type"); return type ? [{ type, name: input ? optionalText(input, "name") : undefined, weightLb: input ? optionalNumber(input, "weightLb") : undefined }] : []; });
}

function parseVehicles(value: unknown): VehicleInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((entry) => { const input = nestedRecord(entry); return input ? [{ makeModel: optionalText(input, "makeModel"), plateState: optionalText(input, "plateState"), plateLastFour: optionalText(input, "plateLastFour") }] : []; });
}

function parseEmergencyContact(value: unknown): EmergencyContact | undefined {
  const input = nestedRecord(value); if (!input) return undefined;
  const name = optionalText(input, "name"); const phone = optionalText(input, "phone");
  return name && phone ? { name, phone, relationship: optionalText(input, "relationship") } : undefined;
}

function parseHouseholdMember(value: unknown): ApplicantHouseholdMemberView[] {
  const input = nestedRecord(value); if (!input) return [];
  const id = optionalText(input, "id"); const firstName = optionalText(input, "firstName"); const lastName = optionalText(input, "lastName");
  return id && firstName && lastName ? [{ id, applicationId: optionalText(input, "applicationId"), firstName, lastName, relationship: optionalText(input, "relationship"), email: optionalText(input, "email"), phone: optionalText(input, "phone"), isMinor: optionalBoolean(input, "isMinor") ?? false }] : [];
}

function parseRequirement(value: unknown): ApplicantRequirementView[] {
  const input = nestedRecord(value); if (!input) return [];
  const id = optionalText(input, "id"); const label = optionalText(input, "label"); const status = optionalText(input, "status"); const requestedOn = optionalText(input, "requestedOn");
  return id && label && status && requestedOn ? [{ id, applicationId: optionalText(input, "applicationId"), label, status, documentId: optionalText(input, "documentId"), requestedOn, resolvedOn: optionalText(input, "resolvedOn") }] : [];
}

function parseDocument(value: unknown): ApplicantDocumentView[] {
  const input = nestedRecord(value); if (!input) return [];
  const id = optionalText(input, "id"); const type = optionalText(input, "type"); const state = optionalText(input, "state"); const fileName = optionalText(input, "fileName"); const mimeType = optionalText(input, "mimeType");
  return id && type && state && fileName && mimeType ? [{ id, type, state, fileName, mimeType, sizeBytes: optionalNumber(input, "sizeBytes"), uploadedAt: optionalText(input, "uploadedAt") }] : [];
}

function safeToken(payload: unknown): string | undefined {
  if (!APPLY_DEMO_ALLOWED || !payload || typeof payload !== "object") return undefined;
  const token = (payload as Record<string, unknown>).resumeToken;
  return typeof token === "string" ? token : undefined;
}

function resumeHeaders(token: string, json = false): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...(json ? { "Content-Type": "application/json" } : {}) };
}

export interface ApplicantStartResult {
  application?: ApplicantPublicView;
  /** Present only for the explicit local demo switch. Never display it in production. */
  demoResumeToken?: string;
  expiresAt?: string;
}

export interface ApplicantPropertyOption {
  id: string;
  name: string;
  slug: string;
  units: Array<{ id: string; unitNumber: string; unitType?: string; bedrooms?: number; bathrooms?: number; marketRentCents?: number }>;
}

export async function loadApplicantPropertyOptions(): Promise<ApplicantPropertyOption[]> {
  if (APPLY_DEMO_ALLOWED) return [{ id: "demo-property", name: "Sample Apartments", slug: "sample-apartments", units: [{ id: "demo-unit", unitNumber: "A-101", bedrooms: 1, bathrooms: 1, marketRentCents: 125000 }] }];
  const payload = await requestJson("/api/rent-ops/public/application-options");
  if (!Array.isArray(payload)) throw new ApplicantPublicError("request", "Available homes could not be loaded.");
  return payload.flatMap((entry) => {
    const property = nestedRecord(entry);
    const id = property && optionalText(property, "id"); const name = property && optionalText(property, "name"); const slug = property && optionalText(property, "slug");
    if (!id || !name || !slug || !Array.isArray(property?.units)) return [];
    const units = property.units.flatMap((entry) => {
      const unit = nestedRecord(entry); const unitId = unit && optionalText(unit, "id"); const unitNumber = unit && optionalText(unit, "unitNumber");
      return unitId && unitNumber ? [{ id: unitId, unitNumber, unitType: optionalText(unit, "unitType"), bedrooms: optionalNumber(unit, "bedrooms"), bathrooms: optionalNumber(unit, "bathrooms"), marketRentCents: optionalNumber(unit, "marketRentCents") }] : [];
    });
    return units.length ? [{ id, name, slug, units }] : [];
  });
}

export async function startApplicantApplication(input: ApplicantStartInput): Promise<ApplicantStartResult> {
  if (APPLY_DEMO_ALLOWED) {
    const result = demoStartApplication(input);
    return { application: result.application, demoResumeToken: result.resumeToken, expiresAt: result.expiresAt };
  }
  const payload = await requestJson("/api/rent-ops/public/applications/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (record.accepted !== true) throw new ApplicantPublicError("request", "We couldn't start the application. Try again.");
  return { expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : undefined };
}

export async function resumeApplicantApplication(token: string): Promise<ApplicantPublicView> {
  if (APPLY_DEMO_ALLOWED) return demoResumeApplication(token);
  return applicationFrom(await requestJson("/api/rent-ops/public/applications/resume", { headers: resumeHeaders(token) }));
}

export async function saveApplicantApplication(token: string, input: ApplicantSaveInput): Promise<ApplicantPublicView> {
  if (APPLY_DEMO_ALLOWED) return demoSaveApplication(input);
  return applicationFrom(await requestJson("/api/rent-ops/public/applications/resume", { method: "PATCH", headers: resumeHeaders(token, true), body: JSON.stringify(input) }));
}

export async function addApplicantHouseholdMember(token: string, input: ApplicantHouseholdMemberInput): Promise<ApplicantPublicView> {
  if (APPLY_DEMO_ALLOWED) {
    return demoAddHouseholdMember({ ...input, id: input.id ?? `demo-member-${Date.now()}`, applicationId: "demo-application-portal" });
  }
  return applicationFrom(await requestJson("/api/rent-ops/public/applications/resume/household-members", { method: "POST", headers: resumeHeaders(token, true), body: JSON.stringify(input) }));
}

export type ApplicantDocumentUploadType = "lease" | "addendum" | "identity" | "insurance" | "notice" | "application_attachment" | "housing_assistance" | "deposit_record" | "other";

export async function uploadApplicantDocument(token: string, file: File, options: { type: ApplicantDocumentUploadType; requirementId?: string }): Promise<ApplicantPublicView> {
  if (APPLY_DEMO_ALLOWED) throw new ApplicantPublicError("request", "Secure document upload is not available in the demo application.");
  const headers: Record<string, string> = {
    ...resumeHeaders(token),
    "Content-Type": file.type || "application/octet-stream",
    "X-Document-Type": options.type,
    "X-Document-Name": file.name,
  };
  if (options.requirementId) headers["X-Application-Requirement-Id"] = options.requirementId;
  return applicationFrom(await requestJson("/api/rent-ops/public/applications/resume/documents", { method: "POST", headers, body: file }));
}

export async function certifyApplicantApplication(token: string): Promise<ApplicantPublicView> {
  if (APPLY_DEMO_ALLOWED) return demoCertifyApplication();
  return applicationFrom(await requestJson("/api/rent-ops/public/applications/resume/certify", { method: "POST", headers: resumeHeaders(token, true), body: JSON.stringify({ certify: true }) }));
}

export async function submitApplicantApplication(token: string): Promise<ApplicantPublicView> {
  if (APPLY_DEMO_ALLOWED) return demoSubmitApplication();
  return applicationFrom(await requestJson("/api/rent-ops/public/applications/resume/submit", { method: "POST", headers: resumeHeaders(token) }));
}

export { APPLY_DEMO_TOKEN };
