import type { DashboardPropertyPoint, DashboardTrends } from "../../../../../shared/rent-ops-dashboard";

export type TrendMetric = "occupancy" | "vacancy" | "rent";
export type TrendMeasure = "rate" | "units";
export type TrendSeries = { id: string; name: string; values: Array<number | null>; unknownUnits: Array<number | null> };

/** Weighted portfolio totals: never average property percentages or treat a gap as zero. */
export function aggregateDashboardPoints(points: DashboardPropertyPoint[]): DashboardPropertyPoint | undefined {
  if (!points.length) return undefined;
  const total = points.reduce((sum, point) => ({ ...sum,
    unitCount: sum.unitCount + point.unitCount,
    occupiedUnits: sum.occupiedUnits + point.occupiedUnits,
    vacantUnits: sum.vacantUnits + point.vacantUnits,
    preleasedUnits: sum.preleasedUnits + point.preleasedUnits,
    unknownUnits: sum.unknownUnits + point.unknownUnits,
    confirmedBaseRentCents: sum.confirmedBaseRentCents + point.confirmedBaseRentCents,
    unconfirmedRentUnits: sum.unconfirmedRentUnits + point.unconfirmedRentUnits,
  }), { propertyId: "portfolio", propertyName: "Portfolio", unitCount: 0, occupiedUnits: 0, vacantUnits: 0,
    preleasedUnits: 0, unknownUnits: 0, confirmedBaseRentCents: 0, unconfirmedRentUnits: 0,
    occupancyRate: null, vacancyRate: null, baseRentCents: null } as DashboardPropertyPoint);
  total.occupancyRate = total.unitCount && !total.unknownUnits ? 100 * total.occupiedUnits / total.unitCount : null;
  total.vacancyRate = total.unitCount && !total.unknownUnits ? 100 * total.vacantUnits / total.unitCount : null;
  total.baseRentCents = points.every(point => point.baseRentCents !== null) ? total.confirmedBaseRentCents : null;
  return total;
}

export function dashboardChartSeries(data: DashboardTrends, selection: string, metric: TrendMetric, measure: TrendMeasure): TrendSeries[] {
  const properties = data.months.at(-1)?.properties ?? [];
  const choices = selection === "compare" ? properties.map(property => ({ id: property.propertyId, name: property.propertyName }))
    : [{ id: selection, name: selection === "portfolio" ? "Portfolio" : properties.find(property => property.propertyId === selection)?.propertyName ?? "Property" }];
  return choices.map(choice => ({ ...choice, unknownUnits: data.months.map(month => {
    const point = choice.id === "portfolio" ? aggregateDashboardPoints(month.properties) : month.properties.find(property => property.propertyId === choice.id);
    return point?.unknownUnits ?? null;
  }), values: data.months.map(month => {
    const point = choice.id === "portfolio" ? aggregateDashboardPoints(month.properties) : month.properties.find(property => property.propertyId === choice.id);
    if (!point) return null;
    if (metric === "rent") return point.baseRentCents === null ? null : point.baseRentCents / 100;
    if (point.unknownUnits && measure === "rate") return null;
    return metric === "occupancy" ? measure === "rate" ? point.occupancyRate : point.occupiedUnits
      : measure === "rate" ? point.vacancyRate : point.vacantUnits;
  }) }));
}

export function chartLineSegments(values: Array<number | null>, x: (i: number) => number, y: (value: number) => number): string {
  let open = false;
  return values.map((value, i) => {
    if (value === null) { open = false; return ""; }
    const command = open ? "L" : "M"; open = true;
    return `${command}${x(i)},${y(value)}`;
  }).join(" ");
}

/** Keep complete percentages as the default; incomplete history is useful as
 * explicitly confirmed counts, never as a partial percentage. */
export function defaultDashboardMeasure(data?: DashboardTrends): TrendMeasure {
  return data?.months.slice(0, -1).some(month => month.properties.some(point => point.unknownUnits > 0)) ? "units" : "rate";
}
