import type { DashboardPropertyPoint, DashboardTrends } from "../../../../../shared/rent-ops-dashboard";

export type TrendMetric = "occupancy" | "vacancy" | "rent";
export type TrendMeasure = "rate" | "units";
export type TrendHistoryMode = "month_end" | "recorded";
export type TrendSeries = { id: string; name: string; values: Array<number | null>; unknownUnits: Array<number | null> };
export type DashboardTrendPoint = DashboardTrends["months"][number] & { sourceSystem?: string };

/** Weighted portfolio totals: never average property percentages or treat a gap as zero. */
export function aggregateDashboardPoints(points: DashboardPropertyPoint[], expectedPropertyIds?: readonly string[]): DashboardPropertyPoint | undefined {
  if (!points.length) return undefined;
  if (expectedPropertyIds) {
    const expected = new Set(expectedPropertyIds);
    const actual = new Set(points.map(point => point.propertyId));
    if (actual.size !== points.length || actual.size !== expected.size || points.some(point => !expected.has(point.propertyId))) return undefined;
  }
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
  total.occupiedUnitsKnown = points.every(point => point.occupiedUnitsKnown !== false);
  total.vacantUnitsKnown = points.every(point => point.vacantUnitsKnown !== false);
  total.preleasedUnitsKnown = points.every(point => point.preleasedUnitsKnown !== false);
  total.occupancyRate = total.unitCount && points.every(point => point.occupancyRate !== null) ? 100 * total.occupiedUnits / total.unitCount : null;
  total.vacancyRate = total.unitCount && points.every(point => point.vacancyRate !== null) ? 100 * total.vacantUnits / total.unitCount : null;
  total.baseRentCents = points.every(point => point.baseRentCents !== null) ? total.confirmedBaseRentCents : null;
  return total;
}

/**
 * Recorded mode is an exact-date view.  It appends the current operational
 * point after archived observations and drops any archive at that same date,
 * so a current point is retained once and remains the final point.
 */
export function dashboardTrendPoints(data: DashboardTrends, mode: TrendHistoryMode = "month_end"): DashboardTrendPoint[] {
  if (mode !== "recorded" || !data.archivedSnapshots?.length) return data.months;
  const current = data.months.at(-1);
  if (!current) return [];
  const byDate = new Map<string, DashboardTrendPoint>();
  const conflicted = new Set<string>();
  for (const archive of [...data.archivedSnapshots].sort((left, right) => left.asOfDate.localeCompare(right.asOfDate))) {
    if (archive.asOfDate > data.asOfDate || archive.asOfDate === current.asOfDate || conflicted.has(archive.asOfDate)) continue;
    const prior = byDate.get(archive.asOfDate);
    const point = { month: archive.asOfDate.slice(0, 7), asOfDate: archive.asOfDate, sourceSystem: archive.sourceSystem, properties: archive.properties };
    if (!prior) byDate.set(archive.asOfDate, point);
    else if (!sameRecordedProperties(prior.properties, point.properties) || prior.sourceSystem !== point.sourceSystem) {
      byDate.delete(archive.asOfDate);
      conflicted.add(archive.asOfDate);
    }
  }
  return [...Array.from(byDate.values()), current];
}

function sourceProperties(data: DashboardTrends, mode: TrendHistoryMode): DashboardPropertyPoint[] {
  return dashboardTrendPoints(data, mode).at(-1)?.properties ?? [];
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function sameRecordedProperties(left: DashboardPropertyPoint[], right: DashboardPropertyPoint[]): boolean {
  return stableValue([...left].sort((a, b) => a.propertyId.localeCompare(b.propertyId)))
    === stableValue([...right].sort((a, b) => a.propertyId.localeCompare(b.propertyId)));
}

function pointAt(month: DashboardTrendPoint, propertyId: string, mode: TrendHistoryMode, expectedPropertyIds: readonly string[] | undefined): DashboardPropertyPoint | undefined {
  return propertyId === "portfolio" ? aggregateDashboardPoints(month.properties, mode === "recorded" ? expectedPropertyIds : undefined) : month.properties.find(property => property.propertyId === propertyId);
}

export function dashboardChartSeries(data: DashboardTrends, selection: string, metric: TrendMetric, measure: TrendMeasure, mode: TrendHistoryMode = "month_end"): TrendSeries[] {
  const points = dashboardTrendPoints(data, mode);
  const properties = sourceProperties(data, mode);
  const expectedPropertyIds = mode === "recorded" ? properties.map(property => property.propertyId) : undefined;
  const choices = selection === "compare" ? properties.map(property => ({ id: property.propertyId, name: property.propertyName }))
    : [{ id: selection, name: selection === "portfolio" ? "Portfolio" : properties.find(property => property.propertyId === selection)?.propertyName ?? "Property" }];
  return choices.map(choice => ({ ...choice, unknownUnits: points.map(month => {
    const point = pointAt(month, choice.id, mode, expectedPropertyIds);
    return point?.unknownUnits ?? null;
  }), values: points.map(month => {
    const point = pointAt(month, choice.id, mode, expectedPropertyIds);
    if (!point) return null;
    if (metric === "rent") return point.baseRentCents === null ? null : point.baseRentCents / 100;
    if (metric === "occupancy" && point.occupiedUnitsKnown === false) return null;
    if (metric === "vacancy" && point.vacantUnitsKnown === false) return null;
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
export function defaultDashboardMeasure(data?: DashboardTrends, mode: TrendHistoryMode = "month_end", metric: TrendMetric = "occupancy"): TrendMeasure {
  const points = data ? dashboardTrendPoints(data, mode) : [];
  return points.slice(0, -1).some(month => month.properties.some(point => metric === "occupancy"
    ? point.occupiedUnitsKnown === false || (point.unknownUnits > 0 && point.occupancyRate === null)
    : metric === "vacancy"
      ? point.vacantUnitsKnown === false || (point.unknownUnits > 0 && point.vacancyRate === null)
      : false)) ? "units" : "rate";
}
