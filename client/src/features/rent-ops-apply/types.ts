/** Positive browser DTOs for the public application flow.  These are kept
 * separate from the persistence contracts so a server field cannot silently
 * become a client dependency. */

export interface RentalHistory {
  currentAddress?: string;
  priorAddress?: string;
  landlordName?: string;
  landlordContact?: string;
  reasonForMoving?: string;
}

export interface EmploymentInfo {
  employerName?: string;
  jobTitle?: string;
  monthlyIncomeCents?: number;
  employmentStartOn?: string;
}

export interface HouseholdSummary {
  adults: number;
  children: number;
  totalOccupants: number;
}

export interface ApplicationPreferences {
  desiredMoveInOn?: string;
  desiredLeaseMonths?: number;
  maxRentCents?: number;
  bedrooms?: number;
}

export interface VoucherInfo {
  hasVoucher: boolean;
  agencyName?: string;
  caseNumber?: string;
  tenantPortionCents?: number;
}

export interface PetInfo {
  type: string;
  name?: string;
  weightLb?: number;
}

export interface VehicleInfo {
  makeModel?: string;
  plateState?: string;
  plateLastFour?: string;
}

export interface EmergencyContact {
  name: string;
  phone: string;
  relationship?: string;
}

export interface ApplicantHouseholdMemberView {
  id: string;
  applicationId?: string;
  firstName: string;
  lastName: string;
  relationship?: string;
  email?: string;
  phone?: string;
  isMinor: boolean;
}

export type ApplicantHouseholdMemberInput = Omit<ApplicantHouseholdMemberView, "id" | "applicationId"> & { id?: string; applicationId?: string };

export interface ApplicantRequirementView {
  id: string;
  applicationId?: string;
  label: string;
  status: string;
  documentId?: string;
  requestedOn: string;
  resolvedOn?: string;
}

export interface ApplicantDocumentView {
  id: string;
  type: string;
  state: string;
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  uploadedAt?: string;
}

export interface ApplicantPublicView {
  id: string;
  status: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  propertyId?: string;
  unitId?: string;
  submittedOn?: string;
  certificationAcceptedOn?: string;
  rentalHistory?: RentalHistory;
  employment?: EmploymentInfo;
  householdSummary?: HouseholdSummary;
  preferences?: ApplicationPreferences;
  voucher?: VoucherInfo;
  pets?: PetInfo[];
  vehicles?: VehicleInfo[];
  emergencyContact?: EmergencyContact;
  householdMembers: ApplicantHouseholdMemberView[];
  requirements: ApplicantRequirementView[];
  documents: ApplicantDocumentView[];
}

export interface ApplicantStartInput {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  currentAddress: string;
}

export interface ApplicantSaveInput {
  phone?: string;
  propertyId?: string;
  unitId?: string;
  rentalHistory?: RentalHistory;
  employment?: EmploymentInfo;
  householdSummary?: HouseholdSummary;
  preferences?: ApplicationPreferences;
  voucher?: VoucherInfo;
  pets?: PetInfo[];
  vehicles?: VehicleInfo[];
  emergencyContact?: EmergencyContact;
}
