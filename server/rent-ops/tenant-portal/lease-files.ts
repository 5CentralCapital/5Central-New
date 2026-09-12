import type { RentOpsDocument, RentOpsTenancy, RentOpsSnapshot, RentOpsPortalTransferHistory } from "../../../shared/rent-ops-contracts";
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

/** Only the exact account's audited transfer path preserves prior PDF access.
 * No person-wide, household, property-wide, or filename-based inheritance. */
export function authorizedTenantLeaseFile(document: RentOpsDocument, account: TenantIdentity, current: RentOpsTenancy,
  snapshot: RentOpsSnapshot, transfers: RentOpsPortalTransferHistory[] = []): TenantLeaseFile | undefined {
  if (isTenantLeaseFile(document, account, current)) return tenantLeaseFile(document);
  if (account.status !== "active" || account.tenancyId !== current.id || account.personId !== current.primaryPersonId) return undefined;
  let next = current;
  let cutoff = Infinity;
  const visited = new Set([current.id]);
  for (let depth = 0; depth < snapshot.tenancies.length; depth++) {
    const edges = transfers.filter(row => row.accountId === account.id && row.personId === account.personId && row.newTenancyId === next.id);
    if (edges.length !== 1) return undefined;
    const edge = edges[0];
    const occurred = Date.parse(edge.occurredAt);
    const old = snapshot.tenancies.find(row => row.id === edge.oldTenancyId);
    if (!old || visited.has(old.id) || !Number.isFinite(occurred) || occurred > cutoff
      || old.primaryPersonId !== account.personId || old.propertyId !== next.propertyId || old.unitId === next.unitId
      || old.operationalEndConfirmationKnowledge !== "manual" || !old.operationalEndConfirmedOn
      || next.occupancyConfirmationKnowledge !== "manual" || next.occupancyConfirmedOn !== old.operationalEndConfirmedOn
      || old.operationalEndConfirmedOn > edge.occurredAt.slice(0,10)
      || [old,next].some(row => !["exact","manual"].includes(row.primaryPersonLinkKnowledge ?? "")
        || !["exact","manual"].includes(row.unitLinkKnowledge ?? "") || !["exact","manual"].includes(row.propertyLinkKnowledge ?? ""))) return undefined;
    const unit = snapshot.units.find(row => row.id === old.unitId && row.propertyId === old.propertyId);
    if (!unit) return undefined;
    if (isTenantLeaseFile(document, {...account,tenancyId:old.id}, old)
      && Date.parse(document.verifiedAt!) <= occurred) return {...tenantLeaseFile(document),priorUnitLabel:unit.unitNumber || "Previous unit"};
    visited.add(old.id); next = old; cutoff = occurred;
  }
  return undefined;
}
