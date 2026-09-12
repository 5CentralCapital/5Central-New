import { deriveTenantNavigation } from "../domain/reports";
import type { Request, Response } from "express";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
const compress = promisify(gzip);
import { emptyRentOpsSnapshot, type RentOpsSnapshot, type RentOpsFilters } from "../../../shared/rent-ops-contracts";
import { serializeAdminSnapshot, serializeAdminChargeDefinition } from "./entities";

export const workspaceBootstrapCollections = ["properties", "units", "people", "tenancies", "householdMemberships", "leaseTerms", "chargeDefinitions"] as const;
export const workspaceCollections = ["recurringSchedules", "ledgerTransactions", "paymentAllocations", "securityDeposits", "subsidyContracts", "applications", "applicationHouseholdMembers", "applicationRequirements", "documents", "activityEvents"] as const;
export type WorkspaceCollection = typeof workspaceCollections[number];

/** A navigation projection is explicitly incomplete and must never enter a financial derivation. */
export function serializeWorkspaceBootstrap(source: RentOpsSnapshot, filters: RentOpsFilters = {}) {
  const projection = emptyRentOpsSnapshot();
  for (const name of workspaceBootstrapCollections) Object.assign(projection, { [name]: source[name] });
  const snapshot = serializeAdminSnapshot(projection);
  const primary = new Map<string, string[]>();
  const memberships = new Map<string, string[]>();
  const accounts = new Set<string>();
  for (const tenancy of source.tenancies) {
    if (tenancy.primaryPersonId) primary.set(tenancy.primaryPersonId, [...(primary.get(tenancy.primaryPersonId) ?? []), tenancy.id]);
  }
  for (const member of source.householdMemberships) {
    memberships.set(member.personId, [...(memberships.get(member.personId) ?? []), ...(member.tenancyId ? [member.tenancyId] : [])]);
    if (member.accountPersonId) accounts.add(member.accountPersonId);
  }
  return {
    workspaceVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    loadedCollections: [...workspaceBootstrapCollections],
    snapshot: { ...snapshot, chargeDefinitions: source.chargeDefinitions.map(serializeAdminChargeDefinition) },
    // Preserve exact relationships; account-only contacts have no inferred tenancy.
    tenantIndex: snapshot.people.filter(person => primary.has(person.id ?? "") || memberships.has(person.id ?? "") || accounts.has(person.id ?? "")).map(person => {
      const accountOnly = accounts.has(person.id ?? "") && !primary.has(person.id ?? "") && !memberships.has(person.id ?? "");
      const scopedNavigation = deriveTenantNavigation(projection, person.id ?? "", filters);
      if ((filters.propertyId || filters.propertyScope === "active") && !scopedNavigation?.tenancies.length) return undefined;
      const navigation = accountOnly ? undefined : scopedNavigation;
      return {
        person,
        tenancyIds: navigation?.tenancies.map(tenancy => tenancy.id) ?? [],
        selectedTenancyId: navigation?.tenancy?.id,
        category: navigation?.category ?? "contact",
        accountContact: accounts.has(person.id ?? ""),
      };
    }).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined),
  };
}

export function serializeWorkspaceCollectionItems<K extends WorkspaceCollection>(items: RentOpsSnapshot[K], name: K) {
  const projection = emptyRentOpsSnapshot();
  Object.assign(projection, { [name]: items });
  return { collection: name, items: serializeAdminSnapshot(projection)[name] };
}

export function serializeWorkspaceCollection(source: RentOpsSnapshot, name: WorkspaceCollection) {
  return serializeWorkspaceCollectionItems(source[name], name);
}

export async function sendWorkspaceJson(req: Request, res: Response, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  res.set("Cache-Control", "no-store");
  res.vary("Accept-Encoding");
  res.type("application/json");
  if (bytes.length >= 65536 && req.headers["accept-encoding"] && req.acceptsEncodings("gzip", "identity") === "gzip") {
    res.set("Content-Encoding", "gzip");
    res.send(await compress(bytes, { level: 4 }));
  } else res.send(bytes);
}
