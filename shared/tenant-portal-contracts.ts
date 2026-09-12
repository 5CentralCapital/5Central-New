/** Public tenant DTOs. Deliberately independent of administrator snapshots. */
export type TenantAccountStatus = "pending" | "active" | "revoked";

export interface TenantIdentity {
  id: string;
  email: string;
  personId: string;
  tenancyId: string;
  status: "active";
}

export interface TenantAccountSummary {
  id: string;
  email: string;
  personId: string;
  tenancyId: string;
  status: TenantAccountStatus;
  /** Administrator-only compare-and-set token for credential mutations. */
  credentialRevision: number;
  createdAt: string;
  activatedAt: string | null;
  invitationExpiresAt: string | null;
}

export interface TenantEligibleTenancy {
  paymentReviewReason?: "assistance_responsibility_unverified" | null;
  personId: string;
  tenancyId: string;
  personName: string;
  email: string | null;
  propertyName: string;
  unitNumber: string;
  status: string;
}

export interface TenantAccountsResponse {
  deliveryAvailable: boolean;
  accounts: TenantAccountSummary[];
  eligibleTenancies: TenantEligibleTenancy[];
}

export interface TenantActivationResponse {
  account: TenantAccountSummary;
  activationPath: string;
  expiresAt: string;
}

export interface TenantSessionResponse {
  account: TenantIdentity;
  csrfToken: string;
}

export interface TenantLedgerEntry {
  id: string;
  date: string | null;
  description: string;
  kind: string;
  status: string | null;
  amountCents: number | null;
  balanceCents: number | null;
}

export interface TenantLeaseFile { id: string; fileName: string; downloadPath: string; priorUnitLabel?: string; }

export interface TenantHome {
  account: TenantIdentity;
  resident: { firstName: string; lastName: string };
  tenancy: {
    id: string;
    propertyId: string;
    unitId: string;
    propertyName: string;
    unitNumber: string;
    address: string;
    status: string;
  };
  balance: { amountCents: number | null; complete: boolean; asOfDate: string };
  ledger: TenantLedgerEntry[];
  leaseFiles: TenantLeaseFile[];
  leases: Array<{ id: string; status: string; startDate: string | null; endDate: string | null; monthToMonth: boolean | null }>;
  deposits: Array<{ id: string; type: string; amountHeldCents: number | null; sourceBalanceCents?: number | null; status: string }>;
}
