import type { RentManagerFinancialSemanticCrosswalk, RentManagerHapStatusCrosswalk, RentManagerRawRecord } from "../../../shared/rent-ops-contracts";
import type { ExportPayload, RentManagerRequest, RentManagerResponse, RentManagerTransport } from "./types";

/** Raw fixture rows deliberately mirror RM's PascalCase API shape. The
 * collector/normalizer, rather than the fixture, adds sourceId/entityType. */
export type SyntheticRawRecord = Record<string, unknown>;
export type SyntheticRecordMap = Record<string, SyntheticRawRecord[]>;

/** Stable external-artifact identity used by the synthetic HAP crosswalk. */
export const SYNTHETIC_HAP_ARTIFACT_SHA256 = "a".repeat(64);

/**
 * Synthetic HAP rows deliberately require the same exact, artifact-bound
 * crosswalk as a real export.  The fixture never falls back to substring or
 * description parsing; callers can supply a different artifact identity when
 * constructing a separately-bound test envelope.
 */
export function syntheticHapStatusCrosswalk(artifactSha256 = SYNTHETIC_HAP_ARTIFACT_SHA256): RentManagerHapStatusCrosswalk[] {
  return [
    { artifactSha256, sourceCollection: "Subsidies", sourceField: "Status", values: { active: "active", ended: "ended", pending: "pending", exception: "exception" } },
    { artifactSha256, sourceCollection: "SubsidyTenants", sourceField: "Status", values: { active: "active", ended: "ended", pending: "pending", exception: "exception" } },
    { artifactSha256, sourceCollection: "SubsidyPayments", sourceField: "Status", values: { received: "received", pending: "pending", voided: "voided", reversed: "reversed" } },
  ];
}

export function syntheticFinancialSemanticCrosswalk(artifactSha256 = SYNTHETIC_HAP_ARTIFACT_SHA256): RentManagerFinancialSemanticCrosswalk {
  return {
    artifactSha256,
    normalization: "trim_lower_unicode_v1",
    entries: [
      { artifactSha256, sourceCollection: "tenants.current", sourceField: "$partition", semanticKind: "tenancy_status", normalization: "trim_lower_unicode_v1", normalizedValue: "current", targetValue: "current" },
      { artifactSha256, sourceCollection: "tenants.future", sourceField: "$partition", semanticKind: "tenancy_status", normalization: "trim_lower_unicode_v1", normalizedValue: "future", targetValue: "future" },
      { artifactSha256, sourceCollection: "tenants.former", sourceField: "$partition", semanticKind: "tenancy_status", normalization: "trim_lower_unicode_v1", normalizedValue: "former", targetValue: "past" },
      { artifactSha256, sourceCollection: "chargeTypes", sourceField: "ChargeTypeID", semanticKind: "charge_category", normalization: "trim_lower_unicode_v1", normalizedValue: "801", targetValue: "base_rent" },
      { artifactSha256, sourceCollection: "recurringSchedules", sourceField: "EntityType", semanticKind: "recurring_scope", normalization: "trim_lower_unicode_v1", normalizedValue: "tenant", targetValue: "tenant" },
    ],
  };
}

export interface SyntheticTransportOptions {
  records?: SyntheticRecordMap;
  failures?: Record<string, number[]>;
  onRequest?: (request: RentManagerRequest) => void;
}

/** Read-only fixture transport. It has no network, credentials, or non-example data. */
export function createSyntheticRentManagerTransport(options: SyntheticTransportOptions = {}): RentManagerTransport {
  const records = options.records ?? syntheticRentManagerRecords();
  const failures = Object.fromEntries(Object.entries(options.failures ?? {}).map(([path, statuses]) => [path, [...statuses]]));
  return {
    async request(request): Promise<RentManagerResponse> {
      options.onRequest?.(request);
      if (String(request.method).toUpperCase() !== "GET") return { status: 405, body: { error: "read_only_fixture" } };
      const queued = failures[request.path];
      if (queued?.length) {
        const status = queued.shift()!;
        return { status, headers: status === 429 ? { "retry-after": "0" } : undefined, body: { error: "synthetic_transient" } };
      }
      let rows = records[request.path];
      if (!rows && request.path.startsWith("/Contacts/") && request.path.endsWith("/PhoneNumbers")) rows = records["/Contacts/{id}/PhoneNumbers"]?.filter((row) => String((row as Record<string, unknown>).ContactID) === request.path.split("/")[2]);
      if (!rows && request.path.startsWith("/Tenants/") && request.path.endsWith("/History")) rows = records["/Tenants/{id}/History"]?.filter((row) => String((row as Record<string, unknown>).TenantID) === request.path.split("/")[2]);
      if (!rows && request.path.startsWith("/Tenants/") && request.path.endsWith("/SecurityDepositSummaries")) rows = records["/Tenants/{id}/SecurityDepositSummaries"]?.filter((row) => String((row as Record<string, unknown>).TenantID) === request.path.split("/")[2]);
      if (!rows) return { status: 404, body: { error: "synthetic_missing_endpoint" } };
      const filters = String(request.query.filters ?? "");
      const statusMatch = filters.match(/Status,eq,([^;]+)/i)?.[1];
      if (statusMatch) rows = rows.filter((row) => String((row as Record<string, unknown>).Status ?? "").toLowerCase() === statusMatch.toLowerCase());
      const page = Math.max(1, Number(request.query.pagenumber ?? 1));
      const size = Math.min(1000, Math.max(1, Number(request.query.pagesize ?? 1000)));
      const start = (page - 1) * size;
      return { status: 200, headers: { "X-Total-Results": String(rows.length) }, body: { Data: rows.slice(start, start + size) } };
    },
  };
}

export function syntheticRentManagerRecords(): SyntheticRecordMap {
  return {
    "/Properties": [{ PropertyID: 1, PropertyName: "Example Test Apartments", Address: { Line1: "1 Example St", City: "Exampleville", State: "FL", Zip: "00001" }, Status: "Active", IsArchived: false }],
    "/Units": [{ UnitID: 11, PropertyID: 1, UnitNumber: "1A", UnitTypeID: 101, MarketRent: 1200, Status: "Active" }],
    "/Tenants": [{ TenantID: 201, PropertyID: 1, UnitID: 11, Status: "Current", FirstName: "Synthetic", LastName: "Tenant", Email: "tenant-201@example.test" }],
    "/Contacts": [{ ContactID: 301, TenantID: 201, ParentType: "Tenant", IsPrimary: true, Email: "tenant-201@example.test" }],
    "/Contacts/{id}/PhoneNumbers": [{ PhoneNumberID: 401, ContactID: 301, PhoneNumber: "555-0101", IsTextReady: true }],
    "/WebUsers": [{ WebUserID: 501, ContactID: 301, Email: "tenant-201@example.test" }],
    "/Leases": [{ LeaseID: 601, TenantID: 201, PropertyID: 1, UnitID: 11, MoveInDate: "2025-01-01", Status: "Current" }],
    "/LeaseTerms": [{ LeaseTermID: 701, Name: "Synthetic Annual" }],
    "/UnitTypes": [{ UnitTypeID: 101, Name: "One Bedroom" }],
    "/ChargeTypes": [{ ChargeTypeID: 801, Name: "Rent" }],
    "/SecurityDepositTypes": [{ SecurityDepositTypeID: 901, Name: "Security" }],
    "/LeaseRenewals": [{ LeaseRenewalID: 611, ParentLeaseID: 601, StartDate: "2026-01-01", EndDate: "2026-12-31" }],
    "/RecurringCharges": [{ RecurringChargeID: 1001, EntityKeyID: 201, EntityType: "Tenant", LeaseID: 601, StartDate: "2025-01-01", Amount: 1200 }],
    "/Charges": [{ ChargeID: 1101, AccountID: 201, LeaseID: 601, PropertyID: 1, UnitID: 11, Amount: 1200, TransactionDate: "2026-01-01" }],
    "/Payments": [{ PaymentID: 1201, AccountID: 201, LeaseID: 601, Amount: 1200, TransactionDate: "2026-01-03", Allocations: [{ AllocationID: 1301, PaymentID: 1201, ChargeID: 1101, Amount: 1200 }] }],
    "/Credits": [{ CreditID: 1401, AccountID: 201, LeaseID: 601, Amount: 10, TransactionDate: "2026-01-04" }],
    "/Tenants/{id}/SecurityDepositSummaries": [{ SecurityDepositSummaryID: 1501, TenantID: 201, LeaseID: 601, Balance: 500, ReceivedDate: "2025-01-01", DepositType: "Security" }],
    "/Subsidies": [{ SubsidyID: 1601, TenantID: 201, LeaseID: 601, PropertyID: 1, UnitID: 11, AgencyName: "Example Housing", StartDate: "2025-01-01", AgencyAmount: 700, TenantAmount: 500, Status: "Active" }],
    "/SubsidyTenants": [{ SubsidyTenantID: 1602, TenantID: 201, SubsidyID: 1601, Amount: 500, Status: "Active", StartDate: "2025-01-01" }],
    "/SubsidyPayments": [{ SubsidyPaymentID: 1603, TenantID: 201, SubsidyID: 1601, PaymentID: 1201, PaymentDate: "2026-01-03", Amount: 700, Payer: "agency", Status: "Received" }],
    "/Prospects": [{ ProspectID: 1701, ContactID: 301, PropertyID: 1 }],
    "/ProspectApplications": [{ ProspectApplicationID: 1801, ProspectID: 1701, ContactID: 301, WebUserID: 501, FirstName: "Synthetic", LastName: "Applicant", Email: "tenant-201@example.test", Status: "Submitted", CreatedDate: "2026-08-01T12:00:00.000Z", UpdatedDate: "2026-08-02T12:00:00.000Z" }],
    "/ProspectApplicationTemplates": [],
    "/ProspectApplicationTemplateFields": [],
    "/ProspectApplicationTemplateMajorSections": [{ ApplicationMajorSectionID: 1802, ApplicationTemplateID: 1800, Title: "Synthetic section" }],
    "/ProspectApplicationTemplateMinorSections": [{ ApplicationMinorSectionID: 1803, ApplicationMajorSectionID: 1802, Title: "Synthetic subsection" }],
    "/ApplicationTemplates": [],
    "/InterestedRentals": [{ InterestedRentalID: 1804, ProspectID: 1701, PropertyID: 1 }],
    "/ApplicationSettings": [{ ApplicationSettingsID: 1805, PropertyID: 1 }],
    "/ProspectSubApplicantDetails": [],
    "/ApplicationSummaries": [],
    "/WebUserAccounts": [{ WebUserAccountID: 502, WebUserID: 501, Email: "tenant-201@example.test" }],
    "/Tenants/{id}/History": [{ HistoryID: 1901, TenantID: 201, ParentType: "Tenant", ParentID: 201, Subject: "Synthetic note", HistoryDate: "2026-08-01T12:00:00.000Z" }],
    "/HistoryNotes": [],
    "/HistoryEmails": [],
    "/EmailSentItems": [{ EmailSentItemID: 2001, ParentID: 201, ParentType: "Tenant", Subject: "Example", Date: "2026-08-01T12:00:00.000Z" }],
    "/EmailChains": [{ EmailChainID: 2002, ParentID: 201, ParentType: "Tenant", Date: "2026-08-01T12:00:00.000Z" }],
    "/TextMessagingConversations": [{ TextMessagingConversationID: 2005, ParentID: 201, ParentType: "Tenant", Date: "2026-08-01T12:00:00.000Z" }],
    "/OutgoingTexts": [{ OutgoingTextID: 2003, ParentID: 201, ParentType: "Tenant", Date: "2026-08-01T12:00:00.000Z" }],
    "/IncomingTexts": [{ IncomingTextID: 2004, ParentID: 201, ParentType: "Tenant", Date: "2026-08-01T12:00:00.000Z" }],
    "/UserDefinedFields": [],
    "/DocumentPackets": [{ DocumentPacketID: 2101, Name: "Synthetic packet", ContentType: "application/pdf" }],
    "/SignableDocumentPackets": [{ SignableDocumentPacketID: 2102, Name: "Synthetic signable packet" }],
    "/SignableDocuments": [{ SignableDocumentID: 2103, DocumentPacketID: 2102, ContentType: "application/pdf" }],
  };
}

export function syntheticExportPayload(): ExportPayload {
  const records = syntheticRentManagerRecords();
  const rows = (path: string): RentManagerRawRecord[] => records[path] as unknown as RentManagerRawRecord[];
  return {
    artifactSha256: SYNTHETIC_HAP_ARTIFACT_SHA256,
    hapStatusCrosswalk: syntheticHapStatusCrosswalk(),
    properties: rows("/Properties"),
    units: rows("/Units"),
    tenants: rows("/Tenants"),
    contacts: rows("/Contacts"),
    phoneNumbers: rows("/Contacts/{id}/PhoneNumbers"),
    webUsers: rows("/WebUsers"),
    webUserAccounts: rows("/WebUserAccounts"),
    leases: rows("/Leases"),
    leaseRenewals: rows("/LeaseRenewals"),
    recurringSchedules: rows("/RecurringCharges"),
    charges: rows("/Charges"),
    payments: rows("/Payments"),
    credits: rows("/Credits"),
    deposits: rows("/Tenants/{id}/SecurityDepositSummaries"),
    subsidies: rows("/Subsidies"),
    subsidyTenants: rows("/SubsidyTenants"),
    subsidyPayments: rows("/SubsidyPayments"),
    applications: rows("/ProspectApplications"),
    prospects: rows("/Prospects"),
    histories: rows("/Tenants/{id}/History"),
    communications: [rows("/EmailSentItems"), rows("/EmailChains"), rows("/OutgoingTexts"), rows("/IncomingTexts")].reduce((all, current) => all.concat(current), []),
    documents: [rows("/DocumentPackets"), rows("/SignableDocumentPackets"), rows("/SignableDocuments")].reduce((all, current) => all.concat(current), []),
    chargeTypeRecords: rows("/ChargeTypes"),
    financialSemanticCrosswalk: syntheticFinancialSemanticCrosswalk(),
    unitTypeRecords: rows("/UnitTypes"),
  };
}

export const createSyntheticTransport = createSyntheticRentManagerTransport;
