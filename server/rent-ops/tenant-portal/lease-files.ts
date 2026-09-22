import type { RentOpsDocument, RentOpsTenancy } from "../../../shared/rent-ops-contracts";
import type { TenantIdentity, TenantLeaseFile } from "../../../shared/tenant-portal-contracts";

/** No filename inference and no household/application-document inheritance.
 * Lease classification must be a source fact or an audited administrator edit;
 * all four parent IDs must identify the authenticated primary tenant's tenancy. */
export function isTenantLeaseFile(document: RentOpsDocument, account: TenantIdentity, tenancy: RentOpsTenancy): boolean {
  return account.status === "active" && account.tenancyId === tenancy.id && account.personId === tenancy.primaryPersonId
    && document.type === "lease" && ["source", "manual"].includes(document.typeKnowledge ?? "")
    && document.state === "verified" && document.availability === "verified"
    && document.mimeType === "application/pdf" && !document.applicationId
    && document.personId === account.personId && document.tenancyId === tenancy.id
    && document.propertyId === tenancy.propertyId && document.unitId === tenancy.unitId
    && document.storageKeyKnowledge === "source" && Boolean(document.storageKey)
    && Boolean(document.verifiedAt) && Number.isSafeInteger(document.sizeBytes) && document.sizeBytes! > 0
    && /^[a-f0-9]{64}$/i.test(document.checksumSha256 ?? "");
}

export function tenantLeaseFile(document: RentOpsDocument): TenantLeaseFile {
  return {id:document.id, fileName:document.fileName, downloadPath:`/api/tenant/lease-files/${encodeURIComponent(document.id)}/download`};
}
