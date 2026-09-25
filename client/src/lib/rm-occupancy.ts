// Rent Manager occupancy for the website admin dashboard.

export interface RentRollSummary { totalUnits: number; occupiedUnits: number; vacantUnits: number; occupancyRate: number; totalMonthlyRent: number }
export interface RmOccupancyRecord { id: string; property: string; units: number; occupied: number; vacant: number; occupancyRate: number; monthlyRent: number; status: string }

/** One record per property whose rent roll loaded. `rentRolls[i]` belongs to
 * `propertyIds[i]`; a failed request (null) is skipped without shifting the
 * other properties' names. */
export function occupancyFromRentRolls(
  propertyIds: readonly string[],
  names: Readonly<Record<string, string>>,
  rentRolls: readonly ({ summary: RentRollSummary } | null)[],
): RmOccupancyRecord[] {
  return propertyIds.flatMap((id, index) => {
    const summary = rentRolls[index]?.summary;
    if (!summary) return [];
    return [{
      id: `rm-occ-${id}`,
      property: names[id] || `Property ${id}`,
      units: summary.totalUnits,
      occupied: summary.occupiedUnits,
      vacant: summary.vacantUnits,
      occupancyRate: Math.round(summary.occupancyRate * 1000) / 10,
      monthlyRent: summary.totalMonthlyRent,
      status: summary.occupancyRate < 0.75 ? "critical" : summary.occupancyRate < 0.9 ? "watch" : "stable",
    }];
  });
}
