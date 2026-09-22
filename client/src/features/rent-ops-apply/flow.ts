import type {
  ApplicantHouseholdMemberInput,
  ApplicantPublicView,
  ApplicantSaveInput,
  ApplicationPreferences,
  EmergencyContact,
  EmploymentInfo,
  HouseholdSummary,
  PetInfo,
  RentalHistory,
  VehicleInfo,
  VoucherInfo,
} from "./types";
import { parseCentsInput } from "../rent-ops/money";

export type ApplyStep = "profile" | "household" | "preferences" | "history-income" | "voucher" | "pets-vehicles" | "documents" | "review";

export const APPLY_STEPS: Array<{ key: ApplyStep; label: string; shortLabel: string }> = [
  { key: "profile", label: "Your profile", shortLabel: "Profile" },
  { key: "household", label: "Household", shortLabel: "Household" },
  { key: "preferences", label: "Home preferences", shortLabel: "Preferences" },
  { key: "history-income", label: "History and income", shortLabel: "History" },
  { key: "voucher", label: "Voucher details", shortLabel: "Voucher" },
  { key: "pets-vehicles", label: "Pets and vehicles", shortLabel: "Pets" },
  { key: "documents", label: "Documents", shortLabel: "Documents" },
  { key: "review", label: "Review and submit", shortLabel: "Review" },
];

export interface ApplicationDraft {
  phone: string;
  propertyId: string;
  unitId: string;
  householdSummary: HouseholdSummary;
  rentalHistory: RentalHistory;
  preferences: ApplicationPreferences;
  employment: EmploymentInfo;
  voucher: VoucherInfo;
  pets: PetInfo[];
  vehicles: VehicleInfo[];
  emergencyContact: EmergencyContact;
}

export type ApplicationDraftPatch = Omit<Partial<ApplicationDraft>, "householdSummary" | "rentalHistory" | "preferences" | "employment" | "voucher" | "emergencyContact"> & {
  householdSummary?: Partial<HouseholdSummary>;
  rentalHistory?: Partial<RentalHistory>;
  preferences?: Partial<ApplicationPreferences>;
  employment?: Partial<EmploymentInfo>;
  voucher?: Partial<VoucherInfo>;
  emergencyContact?: Partial<EmergencyContact>;
};

export function mergeApplicationDraft(current: ApplicationDraft, patch: ApplicationDraftPatch): ApplicationDraft {
  return {
    ...current,
    ...patch,
    householdSummary: patch.householdSummary ? { ...current.householdSummary, ...patch.householdSummary } : current.householdSummary,
    rentalHistory: patch.rentalHistory ? { ...current.rentalHistory, ...patch.rentalHistory } : current.rentalHistory,
    preferences: patch.preferences ? { ...current.preferences, ...patch.preferences } : current.preferences,
    employment: patch.employment ? { ...current.employment, ...patch.employment } : current.employment,
    voucher: patch.voucher ? { ...current.voucher, ...patch.voucher } : current.voucher,
    emergencyContact: patch.emergencyContact ? { ...current.emergencyContact, ...patch.emergencyContact } : current.emergencyContact,
  };
}

/** Merge one controlled household-member field without relying on a stale render closure. */
export function mergeApplicantHouseholdMember(current: ApplicantHouseholdMemberInput, patch: Partial<ApplicantHouseholdMemberInput>): ApplicantHouseholdMemberInput {
  return { ...current, ...patch };
}

/** Trim member fields and omit blank optional values before the strict API boundary. */
export function normalizeApplicantHouseholdMember(input: ApplicantHouseholdMemberInput): ApplicantHouseholdMemberInput {
  const normalized: ApplicantHouseholdMemberInput = {
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    isMinor: input.isMinor,
  };
  if (input.id?.trim()) normalized.id = input.id.trim();
  if (input.relationship?.trim()) normalized.relationship = input.relationship.trim();
  if (input.email?.trim()) normalized.email = input.email.trim();
  if (input.phone?.trim()) normalized.phone = input.phone.trim();
  return normalized;
}

export function draftFromApplication(application: ApplicantPublicView): ApplicationDraft {
  return {
    phone: application.phone ?? "",
    propertyId: application.propertyId ?? "",
    unitId: application.unitId ?? "",
    householdSummary: application.householdSummary ?? { adults: 1, children: 0, totalOccupants: 1 },
    rentalHistory: application.rentalHistory ?? {},
    preferences: application.preferences ?? {},
    employment: application.employment ?? {},
    voucher: application.voucher ?? { hasVoucher: false },
    pets: application.pets ?? [],
    vehicles: application.vehicles ?? [],
    emergencyContact: application.emergencyContact ?? { name: "", phone: "", relationship: "" },
  };
}

export function saveInputFromDraft(draft: ApplicationDraft): ApplicantSaveInput {
  return {
    phone: draft.phone.trim() || undefined,
    propertyId: draft.propertyId.trim() || undefined,
    unitId: draft.unitId.trim() || undefined,
    householdSummary: draft.householdSummary,
    rentalHistory: compactObject(draft.rentalHistory),
    preferences: compactObject(draft.preferences),
    employment: compactObject(draft.employment),
    voucher: draft.voucher.hasVoucher ? compactObject(draft.voucher) : { hasVoucher: false },
    pets: draft.pets.length ? draft.pets : undefined,
    vehicles: draft.vehicles.length ? draft.vehicles : undefined,
    emergencyContact: draft.emergencyContact.name.trim() && draft.emergencyContact.phone.trim()
      ? compactObject(draft.emergencyContact)
      : undefined,
  };
}

function compactObject<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== "" && entry !== undefined && entry !== null)) as T;
}

export function validateStart(input: { email: string; firstName: string; lastName: string; phone: string; currentAddress: string }): string | null {
  if (!input.firstName.trim()) return "Enter your first name.";
  if (!input.lastName.trim()) return "Enter your last name.";
  if (!/^\S+@\S+\.\S+$/.test(input.email.trim())) return "Enter a valid email address.";
  if (!input.phone.trim()) return "Enter a phone number.";
  if (!input.currentAddress.trim()) return "Enter your current address.";
  return null;
}

export function validateStep(step: ApplyStep, draft: ApplicationDraft): string | null {
  if (step === "profile") {
    if (!draft.phone.trim()) return "Enter a phone number so the property team can reach you.";
    if (draft.householdSummary.adults < 1 || draft.householdSummary.totalOccupants < 1) return "Enter at least one adult and one occupant.";
    if (draft.householdSummary.totalOccupants < draft.householdSummary.adults + draft.householdSummary.children) return "Total occupants cannot be below adults plus children.";
  }
  if (step === "household" && draft.householdSummary.totalOccupants < 1) return "Enter the total number of occupants.";
  if (step === "preferences" && draft.preferences.desiredMoveInOn && !/^\d{4}-\d{2}-\d{2}$/.test(draft.preferences.desiredMoveInOn)) return "Use a valid move-in date.";
  if (step === "voucher" && draft.voucher.hasVoucher && !draft.voucher.agencyName?.trim()) return "Enter the housing agency name or choose No voucher.";
  if (step === "review") return null;
  return null;
}

export function parseResumeToken(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const validToken = (candidate: string | null): string | null => {
    const normalized = candidate?.trim() ?? "";
    return /^[A-Za-z0-9_-]{40,200}$/.test(normalized) ? normalized : null;
  };

  // A bare token is still accepted when an applicant pastes the credential
  // itself into the resume form. URL credentials are only accepted from the
  // fragment; query parameters are deliberately never inspected.
  if (/^[A-Za-z0-9_-]{40,200}$/.test(value)) return value;
  try {
    const url = new URL(value, "https://apply.invalid");
    if (!url.hash) return null;
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    return validToken(fragment.get("resume") ?? fragment.get("token"));
  } catch {
    return null;
  }
}

export function centsFromDollars(value: string): number | undefined {
  return parseCentsInput(value);
}

export function dollarsFromCents(value: number | undefined): string {
  return typeof value === "number" ? (value / 100).toFixed(2) : "";
}
