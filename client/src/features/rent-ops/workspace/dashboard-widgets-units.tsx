// Unit widgets: a map of every unit, vacancies by age, readiness and listing,
// rent by property and bedroom, loss to lease, and records missing data.
import React from "react";
import {
  Bars, Empty, Foot, LIST_ROW, Loading, Rows, SIZESETS, Stack, TABLE_ROW, TILE, Table, Tile,
  dollars, fitRows, groupByProperty, humanLabel, isSmall, money, numeric, pct, sumKnown, text, unitCell,
  type DashboardData, type Row, type WidgetContext, type WidgetDefinition,
} from "./dashboard-kit";

const LONG = 90;
const vacantRows = (data: DashboardData) => data.vacancy?.filter(row => row.occupancy !== "future_preleased");

function UnitMap({ data, metrics }: WidgetContext) {
  if (!data.rentRoll) return <Loading />;
  const days = new Map((data.vacancy ?? []).map(row => [String(row.unitId), row.daysVacant] as const));
  const groups = groupByProperty(data.rentRoll, () => ({ units: [] as Row[] }), (group, row) => { group.units.push(row); });
  const tone = (row: Row) => {
    if (row.occupancy === "current") return "occupied";
    if (row.occupancy === "future_preleased") return "preleased";
    if (row.occupancy === "vacant") { const value = days.get(String(row.unitId)); return numeric(value) && value >= LONG ? "stale" : "vacant"; }
    return "unknown";
  };
  const counts = { occupied: 0, preleased: 0, vacant: 0, stale: 0, unknown: 0 } as Record<string, number>;
  for (const row of data.rentRoll) counts[tone(row)] += 1;
  return <div className="ops-unitmap">
    <div className="ops-unitmap-groups">{groups.map(group => <div key={group.propertyId} className="ops-unitmap-group"><span>{group.propertyName}<small>{group.units.filter(row => row.occupancy === "current").length}/{group.units.length}</small></span>
      <div>{group.units.sort((a, b) => String(a.unitNumber).localeCompare(String(b.unitNumber), undefined, { numeric: true })).map((row, index) => <button key={`${row.unitId}-${index}`} type="button" className="ops-unitmap-cell" data-tone={tone(row)} title={`${text(row.unitNumber)} · ${humanLabel(String(row.occupancy ?? "unknown"))}${days.get(String(row.unitId)) !== undefined ? ` · ${text(days.get(String(row.unitId)))} days vacant` : ""}`} onClick={() => row.unitId && data.onOpenUnit?.(String(row.unitId))} />)}</div>
    </div>)}</div>
    {metrics.h > 2 && <ul className="ops-unitmap-legend">{[["occupied", "Occupied"], ["preleased", "Preleased"], ["vacant", "Vacant"], ["stale", `Vacant ${LONG}+ days`], ["unknown", "Unknown"]].map(([key, label]) => counts[key] ? <li key={key} data-tone={key}><i />{label} {counts[key]}</li> : null)}</ul>}
  </div>;
}

function VacantTile({ data, metrics }: WidgetContext) {
  if (!data.vacancy || !data.propertyRows) return <Loading />;
  const vacant = vacantRows(data)!;
  const units = sumKnown(data.propertyRows, "unitCount");
  const preleased = data.vacancy.length - vacant.length;
  return <Tile label="Vacant units" big={isSmall(metrics)} value={String(vacant.length)} meter={units ? vacant.length / units : undefined} tone={vacant.length ? "attention" : undefined} detail={`${units ? pct(vacant.length / units) : "—"} of ${units ?? "—"} units${preleased ? ` · ${preleased} preleased` : ""}`} />;
}

function Preleased({ data, metrics }: WidgetContext) {
  if (!data.rentRoll) return <Loading />;
  const rows = data.rentRoll.filter(row => row.occupancy === "future_preleased" || (row.occupancy === "vacant" && row.futureTenantName));
  if (!rows.length) return <Empty title="Nothing preleased">Units with a signed future tenant show here.</Empty>;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={rows.map((row, index) => ({ key: `${row.unitId}-${index}`, label: <>{text(row.propertyName)} {text(row.unitNumber)}</>, detail: text(row.futureTenantName), value: money(row.baseRentCents ?? row.marketRentCents), tone: "positive" as const }))} />;
}

function RentByProperty({ data, metrics }: WidgetContext) {
  if (!data.propertyRows) return <Loading />;
  const rows = [...data.propertyRows].sort((a, b) => Number(b.rent) - Number(a.rent));
  const total = sumKnown(rows, "rent");
  return <><Bars limit={fitRows(metrics, LIST_ROW, 30, 1)} items={rows.map(row => ({ key: String(row.propertyId), label: <>{text(row.propertyName)} <small>{text(row.occupied)} occ.</small></>, value: Number(row.rent) || 0, display: row.rentUnknown ? `${dollars(Number(row.rent) || 0)}+` : undefined }))} />
    <Foot>Rent roll {total === undefined ? "—" : dollars(total)} a month</Foot></>;
}

function RentByBedroom({ data, metrics }: WidgetContext) {
  if (!data.rentRoll) return <Loading />;
  const units = new Map(data.snapshot.snapshot.units.map(unit => [String(unit.id), unit] as const));
  const groups = new Map<string, { rent: number; rentCount: number; market: number; marketCount: number }>();
  for (const row of data.rentRoll) {
    const unit = units.get(String(row.unitId));
    const key = unit?.bedrooms == null ? "Not recorded" : `${unit.bedrooms} bed`;
    const group = groups.get(key) ?? { rent: 0, rentCount: 0, market: 0, marketCount: 0 };
    if (row.occupancy === "current" && numeric(row.baseRentCents)) { group.rent += row.baseRentCents; group.rentCount += 1; }
    if (numeric(row.marketRentCents)) { group.market += row.marketRentCents; group.marketCount += 1; }
    groups.set(key, group);
  }
  const items = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  if (!items.length) return <Empty title="No unit records" />;
  return <Rows limit={fitRows(metrics, LIST_ROW, 0)} items={items.map(([key, group]) => ({ key, label: key, detail: `market ${group.marketCount ? dollars(group.market / group.marketCount) : "—"}`, value: group.rentCount ? `${dollars(group.rent / group.rentCount)} avg` : "—" }))} />;
}

function LongVacancies({ data, metrics }: WidgetContext) {
  const vacant = vacantRows(data);
  if (!vacant) return <Loading />;
  const rows = vacant.filter(row => numeric(row.daysVacant) && row.daysVacant >= LONG).sort((a, b) => Number(b.daysVacant) - Number(a.daysVacant));
  const lost = rows.reduce((sum, row) => sum + (numeric(row.marketRentCents) ? row.marketRentCents * Number(row.daysVacant) / 30 : 0), 0);
  return <Table rows={rows} limit={fitRows(metrics, TABLE_ROW, 40)} empty={`No unit has been vacant ${LONG}+ days.`} onMore={() => data.onReport("occupancy")} columns={[
    { key: "unitNumber", label: "Unit", render: row => unitCell(data, row) },
    { key: "daysVacant", label: "Days", number: true, render: row => <span data-tone="critical">{text(row.daysVacant)}</span> },
    { key: "marketRentCents", label: "Asking", number: true, render: row => money(row.marketRentCents) },
  ]} footer={<span>{rows.length} units · about {dollars(lost)} of rent lost so far</span>} />;
}

function LossToLease({ data, metrics }: WidgetContext) {
  if (!data.rentRoll) return <Loading />;
  const rows = data.rentRoll.filter(row => row.occupancy === "current" && numeric(row.baseRentCents) && numeric(row.marketRentCents) && row.marketRentCents > row.baseRentCents)
    .map(row => ({ ...row, gapCents: (row.marketRentCents as number) - (row.baseRentCents as number) }) as Row & { gapCents: number }).sort((a, b) => b.gapCents - a.gapCents);
  if (!rows.length) return <Empty title="No units below market">Occupied units rented under their market rent show here.</Empty>;
  const total = rows.reduce((sum, row) => sum + row.gapCents, 0);
  return <><Tile label="Below market" big={isSmall(metrics)} value={`${dollars(total)}/mo`} detail={`${rows.length} occupied units · ${dollars(total * 12)} a year`} />
    {!isSmall(metrics) && <Bars limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={rows.map((row, index) => ({ key: `${row.unitId}-${index}`, label: <>{text(row.propertyName)} {text(row.unitNumber)} <small>{money(row.baseRentCents)}</small></>, value: row.gapCents }))} />}</>;
}

function Readiness({ data, metrics }: WidgetContext) {
  const vacant = vacantRows(data);
  if (!vacant || !data.rentRoll) return <Loading />;
  const readiness = new Map(data.rentRoll.map(row => [String(row.unitId), row] as const));
  const counts = new Map<string, number>();
  for (const row of vacant) { const key = humanLabel(String(readiness.get(String(row.unitId))?.readiness ?? "not recorded")); counts.set(key, (counts.get(key) ?? 0) + 1); }
  if (!vacant.length) return <Empty title="No vacant units" />;
  return <><Tile label="Vacant units by readiness" value={String(vacant.length)} big={isSmall(metrics)} />{!isSmall(metrics) && <Bars format={value => `${value}`} limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ key: label, label, value: count, tone: /not|turn|make/i.test(label) ? "critical" as const : undefined }))} />}</>;
}

function Listings({ data, metrics }: WidgetContext) {
  const vacant = vacantRows(data);
  if (!vacant || !data.rentRoll) return <Loading />;
  const byUnit = new Map(data.rentRoll.map(row => [String(row.unitId), row] as const));
  const listed = vacant.filter(row => /listed|marketed|active/i.test(String(byUnit.get(String(row.unitId))?.listing ?? "")));
  const unlisted = vacant.filter(row => !listed.includes(row));
  return <><Stack format={value => String(value)} parts={[{ key: "listed", label: "Listed", value: listed.length, tone: "positive" }, { key: "unlisted", label: "Not listed", value: unlisted.length, tone: "critical" }]} />
    {metrics.h > 2 && <Rows limit={fitRows(metrics, LIST_ROW, 70, 1)} items={unlisted.map((row, index) => ({ key: `${row.unitId}-${index}`, label: <>{text(row.propertyName)} {text(row.unitNumber)}</>, detail: humanLabel(String(byUnit.get(String(row.unitId))?.listing ?? "not listed")), value: numeric(row.daysVacant) ? `${row.daysVacant}d` : "—" }))} />}</>;
}

function MissingData({ data, metrics }: WidgetContext) {
  if (!data.rentRoll) return <Loading />;
  const units = new Map(data.snapshot.snapshot.units.map(unit => [String(unit.id), unit] as const));
  const gaps = data.rentRoll.map(row => {
    const unit = units.get(String(row.unitId));
    const missing = [unit?.bedrooms == null ? "bedrooms" : "", !numeric(row.marketRentCents) ? "market rent" : "", row.occupancy === "current" && !numeric(row.baseRentCents) ? "rent" : "", !row.occupancy || row.occupancy === "unknown" ? "occupancy" : ""].filter(Boolean);
    return { row, missing };
  }).filter(entry => entry.missing.length);
  if (!gaps.length) return <Empty title="Unit records complete">Every unit has bedrooms, market rent and occupancy.</Empty>;
  return <><Tile label="Units missing data" value={String(gaps.length)} tone="review" big={isSmall(metrics)} detail="Fill these so vacancy cost and rent comparisons are exact" />
    {!isSmall(metrics) && <Rows limit={fitRows(metrics, LIST_ROW, TILE, 1)} items={gaps.map((entry, index) => ({ key: `${entry.row.unitId}-${index}`, label: <>{text(entry.row.propertyName)} {text(entry.row.unitNumber)}</>, value: entry.missing.join(", "), tone: "muted" as const }))} />}</>;
}

function UnitCounts({ data, metrics }: WidgetContext) {
  if (!data.propertyRows) return <Loading />;
  const units = sumKnown(data.propertyRows, "unitCount"), occupied = sumKnown(data.propertyRows, "occupied"), vacant = sumKnown(data.propertyRows, "vacant");
  return <><Tile label="Units" big={isSmall(metrics)} value={units === undefined ? "—" : String(units)} detail={`${data.propertyRows.length} properties`} />
    {!isSmall(metrics) && <Stack format={value => String(value)} parts={[{ key: "occupied", label: "Occupied", value: occupied ?? 0, tone: "positive" }, { key: "vacant", label: "Vacant", value: vacant ?? 0, tone: "critical" }, { key: "unknown", label: "Unknown", value: sumKnown(data.propertyRows, "unknown") ?? 0, tone: "muted" }]} />}</>;
}

export const UNIT_WIDGETS: readonly WidgetDefinition[] = [
  { id: "unit-map", category: "units", name: "Unit map", description: "One square per unit: occupied, preleased, vacant, vacant 90+ days", sizes: ["M", "MT", "W", "XT", "XL", "F"], defaultSize: "W", render: context => <UnitMap {...context} />, open: data => () => data.onReport("occupancy") },
  { id: "vacant-tile", category: "units", name: "Vacant units", description: "Vacant units as a share of all units, with preleased", sizes: SIZESETS.tile, defaultSize: "S", render: context => <VacantTile {...context} />, open: data => () => data.onReport("occupancy") },
  { id: "unit-count", category: "units", name: "Unit count", description: "Units in scope split by occupied, vacant and unknown", sizes: SIZESETS.tile, defaultSize: "M", render: context => <UnitCounts {...context} /> },
  { id: "preleased", category: "units", name: "Preleased units", description: "Units with a signed future tenant", sizes: SIZESETS.list, defaultSize: "M", render: context => <Preleased {...context} /> },
  { id: "long-vacancies", category: "units", name: "Long vacancies", description: `Units vacant ${LONG}+ days with asking rent and rent lost`, sizes: SIZESETS.table, defaultSize: "L", render: context => <LongVacancies {...context} />, open: data => () => data.onReport("occupancy") },
  { id: "unit-readiness", category: "units", name: "Make-ready", description: "Vacant units by readiness: the turn queue", sizes: SIZESETS.list, defaultSize: "M", render: context => <Readiness {...context} />, open: data => () => data.onReport("occupancy") },
  { id: "listings", category: "units", name: "Listed units", description: "Vacant units marketed now versus not listed", sizes: SIZESETS.list, defaultSize: "M", render: context => <Listings {...context} /> },
  { id: "rent-by-property", category: "units", name: "Rent roll by property", description: "Monthly base rent on occupied units per property", sizes: SIZESETS.list, defaultSize: "M", render: context => <RentByProperty {...context} />, open: data => () => data.onReport("rent-roll") },
  { id: "rent-by-bedroom", category: "units", name: "Rent by bedroom", description: "Average in-place rent and market rent by bedroom count", sizes: SIZESETS.list, defaultSize: "M", render: context => <RentByBedroom {...context} /> },
  { id: "loss-to-lease", category: "units", name: "Units below market", description: "Occupied units rented under market, largest gap first", sizes: SIZESETS.list, defaultSize: "MT", render: context => <LossToLease {...context} /> },
  { id: "missing-unit-data", category: "units", name: "Units missing data", description: "Units without bedrooms, market rent, rent or occupancy", sizes: SIZESETS.list, defaultSize: "M", render: context => <MissingData {...context} /> },
];
