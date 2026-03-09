/**
 * Centralized property ID mapping.
 * Maps between local DB UUIDs, Rent Manager integer IDs, and property names.
 *
 * Local DB: UUIDs (used by /api/properties/current, /api/lease-up, /api/monthly-data)
 * Rent Manager: integers 30-33 (used by /api/rm/* endpoints)
 */

export interface PropertyMapping {
  localId: string;      // UUID from local DB
  rmId: number;         // Rent Manager PropertyID (30-33)
  rmIdStr: string;      // String version for convenience
  name: string;         // Short name: "MLK", "Hickory", etc.
  fullName: string;     // Display name: "MLK Apartments", etc.
  address: string;
  city: string;
  units: number;        // Total unit count (informational)
}

export const PROPERTY_MAP: PropertyMapping[] = [
  {
    localId: "ea28fe29-c3e4-4ccd-a68d-a38dbd6b52fb",
    rmId: 30,
    rmIdStr: "30",
    name: "MLK",
    fullName: "MLK Apartments",
    address: "3408 E Dr MLK Blvd",
    city: "Tampa",
    units: 10,
  },
  {
    localId: "48385b5c-791a-455d-a358-5f1947b448e3",
    rmId: 31,
    rmIdStr: "31",
    name: "Hickory",
    fullName: "Hickory Landing",
    address: "2006 W Hickory St",
    city: "Lakeland",
    units: 8,
  },
  {
    localId: "ba502e16-e1ee-4925-baff-1b156ad37133",
    rmId: 32,
    rmIdStr: "32",
    name: "Sun Cove",
    fullName: "Sun Cove Apartments",
    address: "5680 28th St N",
    city: "St Petersburg",
    units: 21,
  },
  {
    localId: "4d7c6538-2f0d-42e2-8c40-6ec57b438a4a",
    rmId: 33,
    rmIdStr: "33",
    name: "Lucia",
    fullName: "Lucia Apartments",
    address: "669 Avenue B NW",
    city: "Winter Haven",
    units: 16,
  },
];

/** All RM property IDs as strings */
export const ALL_RM_IDS = PROPERTY_MAP.map((p) => p.rmIdStr);

/** All RM property IDs as numbers */
export const ALL_RM_ID_NUMS = PROPERTY_MAP.map((p) => p.rmId);

// ─── Lookup helpers ─────────────────────────────────────────────

/** Get mapping by local DB UUID */
export function byLocalId(localId: string): PropertyMapping | undefined {
  return PROPERTY_MAP.find((p) => p.localId === localId);
}

/** Get mapping by Rent Manager integer ID */
export function byRmId(rmId: number | string): PropertyMapping | undefined {
  const id = typeof rmId === "string" ? parseInt(rmId, 10) : rmId;
  return PROPERTY_MAP.find((p) => p.rmId === id);
}

/** Get mapping by short name (case-insensitive) */
export function byName(name: string): PropertyMapping | undefined {
  const lower = name.toLowerCase();
  return PROPERTY_MAP.find((p) => p.name.toLowerCase() === lower || p.fullName.toLowerCase() === lower);
}

/** Convert local UUID to RM ID (returns undefined if not found) */
export function localToRm(localId: string): number | undefined {
  return byLocalId(localId)?.rmId;
}

/** Convert RM ID to local UUID (returns undefined if not found) */
export function rmToLocal(rmId: number | string): string | undefined {
  return byRmId(rmId)?.localId;
}

/** Get display name from RM ID */
export function rmIdToName(rmId: number | string): string {
  return byRmId(rmId)?.fullName || `Property ${rmId}`;
}

/** Get display name from local UUID */
export function localIdToName(localId: string): string {
  return byLocalId(localId)?.fullName || localId;
}

/** Record of RM ID string -> full name (for frontend overlays) */
export const RM_PROP_NAMES: Record<string, string> = Object.fromEntries(
  PROPERTY_MAP.map((p) => [p.rmIdStr, p.fullName])
);

/** Record of RM ID number -> short name (backwards compat with rentmanager.ts) */
export const PROPERTY_NAMES: Record<number, string> = Object.fromEntries(
  PROPERTY_MAP.map((p) => [p.rmId, p.name])
);
