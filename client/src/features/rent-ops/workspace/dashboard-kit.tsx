// Shared pieces for dashboard widgets: the data contract every widget reads,
// the widget definition, and the small presentational parts (tiles, rows,
// bars, tables, charts) that size themselves to the cell they are given.
// Unknown amounts stay unknown: helpers return "—" or "Unknown", never $0.
import React, { useEffect, useMemo, useState, type ReactNode } from "react";
import type { BankingSnapshot } from "../../../../../shared/rent-ops-banking";
import type { DashboardCash, DashboardTrends } from "../../../../../shared/rent-ops-dashboard";
import type { AdminSnapshot, ReportKey, TenantTab, ViewFilters } from "../types";
import { formatReportValue } from "./report-model";
import type { TrendMetric } from "./dashboard-model";
import { formatWholeDollars, type DashboardKpi, type DueSplit } from "./dashboard-kpis";
import type { AttentionItem } from "./dashboard-attention";
import { Skeleton } from "./ops-ui";
import { EntityLink, RecordLink } from "./entity-link";
import type { WidgetSize } from "./dashboard-grid-model";

export type Row = Record<string, unknown>;
export type Column = { key: string; label: string; number?: boolean; render?: (row: Row) => ReactNode };
export const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export const money = (value: unknown) => numeric(value) ? formatReportValue(value, "currency") : "—";
export const text = (value: unknown) => value === null || value === undefined || value === "" ? "—" : String(value);
export const dollars = (cents: number) => formatWholeDollars(cents);
export const pct = (share: number) => `${Math.round(share * 100)}%`;

/* ---------- categories ---------- */

// "rent" keeps its key so saved library state and callers stay valid; it is the Tenants tab.
export type WidgetCategory = "rent" | "units" | "cash" | "accounting" | "qb" | "projects" | "company";
export const WIDGET_CATEGORIES: Record<WidgetCategory, string> = {
  rent: "Tenants", units: "Units", cash: "Cash", accounting: "Accounting", qb: "QuickBooks", projects: "Projects", company: "Company & tools",
};

/* ---------- data contract ---------- */

export interface WidgetMetrics { size: WidgetSize; w: number; h: number; bodyWidth: number; bodyHeight: number }

export type CompanySection = "projects" | "investors" | "forecasting" | "accounting" | "work-orders" | "review-queue";
export interface CompanyTarget { projectTab?: string; investorTab?: string; accountingView?: string; workOrderView?: string; forecastTab?: string; recordId?: string }

export interface DashboardData {
  snapshot: AdminSnapshot;
  filters: ViewFilters;
  identity: string;
  year: number;
  monthLabel: string;
  kpis: DashboardKpi[];
  attention: AttentionItem[];
  companyPanels?: ReactNode;
  rentRoll?: Row[];
  dueRows?: Row[];
  knownDue?: Row[];
  unverifiedDue: number;
  dueSplit?: DueSplit;
  receipts?: Row[];
  vacancy?: Row[];
  vacancySorted?: Row[];
  propertyRows?: Row[];
  movements?: Row[];
  applications?: Row[];
  applicationsError?: boolean;
  onOpenApplication: (id: string) => void;
  trends: { data?: DashboardTrends; loading: boolean; error?: string; retry: () => void; metric: TrendMetric; setMetric: (metric: TrendMetric) => void };
  cash: { data?: DashboardCash; error?: string; fetching: boolean; refetch: () => void };
  banking: { data?: BankingSnapshot; error?: string; loading: boolean; refetch: () => void };
  onReport: (report: ReportKey) => void;
  onOpenTenant?: (personId: string, tab?: TenantTab) => void;
  onOpenUnit?: (unitId: string) => void;
  onOpenProperty?: (propertyId: string) => void;
  onManageMoves?: () => void;
  /** The company chosen in the route; company widgets fall back to the only company. */
  organizationId?: string;
  onOpenCompany?: (section: CompanySection, organizationId: string | undefined, target?: CompanyTarget) => void;
}

export interface WidgetContext { data: DashboardData; metrics: WidgetMetrics }

export interface WidgetDefinition {
  id: string;
  category: WidgetCategory;
  name: string;
  description: string;
  sizes: readonly WidgetSize[];
  defaultSize: WidgetSize;
  /** The widget draws its own header (the trend chart). */
  bare?: boolean;
  /** Long lists that are meant to scroll inside the card. */
  scrolls?: boolean;
  /** Optional "open" target shown in the header. */
  open?: (data: DashboardData) => (() => void) | undefined;
  render: (context: WidgetContext) => ReactNode;
}

/** Size sets widgets reuse, so every widget can be resized. */
export const SIZESETS = {
  tile: ["S", "M"],
  tileWide: ["S", "M", "MT"],
  list: ["S", "M", "MT", "L"],
  card: ["M", "MT", "L", "XT"],
  table: ["MT", "L", "XL", "F6"],
  wideTable: ["L", "XL", "F", "F6"],
  chart: ["M", "MT", "L", "XT", "XL"],
  wideChart: ["W", "XT", "XL", "FT", "F"],
  grid: ["XL", "F", "F6"],
} as const satisfies Record<string, readonly WidgetSize[]>;

/* ---------- shared pieces ---------- */

export const TABLE_ROW = 46, LIST_ROW = 38, TILE = 70;
/** How many rows of a given height fit in the body after a reserved block. */
export const fitRows = (metrics: WidgetMetrics, rowHeight: number, reserve = 0, minimum = 2) => Math.max(minimum, Math.floor((metrics.bodyHeight - reserve - 30) / rowHeight));
export const isSmall = (metrics: WidgetMetrics) => metrics.size === "S";

export function Tile({ label, value, detail, tone, big = false, meter }: { label?: string; value: ReactNode; detail?: ReactNode; tone?: string; big?: boolean; meter?: number }) {
  return <div className={`ops-tile${big ? " is-big" : ""}`} data-tone={tone}>
    {label && <span className="ops-tile-label">{label}</span>}
    <strong className="ops-tile-value">{value}</strong>
    {meter !== undefined && <span className="rops-kpi-meter" aria-hidden="true"><i style={{ width: `${Math.round(Math.max(0, Math.min(1, meter)) * 100)}%` }} /></span>}
    {detail && <span className="ops-tile-detail">{detail}</span>}
  </div>;
}

export type RowItem = { key: string; label: ReactNode; detail?: ReactNode; value: ReactNode; tone?: "positive" | "critical" | "muted" };
export function Rows({ items, limit }: { items: RowItem[]; limit?: number }) {
  const shown = limit ? items.slice(0, limit) : items;
  return <ul className="ops-rows">{shown.map(item => <li key={item.key}><span className="ops-rows-label">{item.label}{item.detail && <small>{item.detail}</small>}</span><span className="ops-rows-value" data-tone={item.tone}>{item.value}</span></li>)}</ul>;
}

export type BarItem = { key: string; label: ReactNode; value: number; tone?: "critical" | "positive" | "muted"; display?: string };
export function Bars({ items, limit, format = value => dollars(value), tone }: { items: BarItem[]; limit?: number; format?: (value: number) => string; tone?: "critical" | "positive" }) {
  const shown = limit ? items.slice(0, limit) : items;
  const max = Math.max(1, ...shown.map(item => Math.abs(item.value)));
  return <ul className="ops-rows ops-bars">{shown.map(item => <li key={item.key}><span className="ops-rows-label">{item.label}</span><span className="rops-unit-track" aria-hidden="true"><i data-tone={item.tone ?? tone} style={{ width: `${Math.abs(item.value) / max * 100}%` }} /></span><span className="ops-rows-value" data-tone={item.tone === "critical" ? "critical" : item.tone === "positive" ? "positive" : undefined}>{item.display ?? format(item.value)}</span></li>)}</ul>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="ops-widget-empty"><strong>{title}</strong>{children && <span>{children}</span>}</div>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="ops-widget-loading"><Skeleton width="60%" label={label} /><Skeleton width="80%" label={label} /><Skeleton width="45%" label={label} /></div>;
}

export function Failed({ title, error, retry }: { title: string; error?: unknown; retry?: () => void }) {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return <Empty title={title}>{detail && <span>{detail}</span>}{retry && <button type="button" className="rops-link" onClick={retry}>Retry</button>}</Empty>;
}

export function Table({ rows, columns, empty = "No records.", footer, limit, onMore, moreLabel, fill = true }: { rows?: Row[]; columns: Column[]; empty?: string; footer?: ReactNode; limit?: number; onMore?: () => void; moreLabel?: (count: number) => string; fill?: boolean }) {
  const [sort, setSort] = useState<{ key: string; direction: number }>();
  const ordered = useMemo(() => !sort ? rows : [...(rows ?? [])].sort((a, b) => {
    const left = a[sort.key], right = b[sort.key];
    if (left == null) return right == null ? 0 : 1;
    if (right == null) return -1;
    return (numeric(left) && numeric(right) ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true })) * sort.direction;
  }), [rows, sort]);
  const shown = limit && ordered ? ordered.slice(0, limit) : ordered;
  const hidden = limit && ordered ? ordered.length - (shown?.length ?? 0) : 0;
  return <><div className={`rmd-table-scroll${fill ? " is-fill" : ""}`}><table><thead><tr>{columns.map(column => <th key={column.key} className={column.number ? "number" : ""} aria-sort={sort?.key === column.key ? sort.direction === 1 ? "ascending" : "descending" : "none"}><button type="button" onClick={() => setSort(current => ({ key: column.key, direction: current?.key === column.key ? -current.direction : 1 }))}>{column.label}{sort?.key === column.key ? sort.direction === 1 ? " ↑" : " ↓" : ""}</button></th>)}</tr></thead><tbody>
    {!rows ? <tr><td colSpan={columns.length} className="rmd-empty"><Skeleton width="10em" /></td></tr> : !ordered?.length ? <tr><td colSpan={columns.length} className="rmd-empty">{empty}</td></tr> : shown!.map((row, index) => <tr key={String(row.id ?? row.unitId ?? row.propertyId ?? "row") + index}>{columns.map(column => <td key={column.key} className={column.number ? "number" : ""}>{column.render ? column.render(row) : text(row[column.key])}</td>)}</tr>)}
  </tbody></table></div>{hidden > 0 && onMore && <div className="rops-table-more"><button type="button" className="rops-link" onClick={onMore}>{moreLabel ? moreLabel(ordered!.length) : `View all ${ordered!.length}`}</button></div>}{footer && <div className="rmd-table-total">{footer}</div>}</>;
}

/** Footer line under a list: a caption and an optional action. */
export function Foot({ children, action, onAction }: { children?: ReactNode; action?: string; onAction?: () => void }) {
  return <div className="rmd-table-total ops-widget-foot"><span>{children}</span>{action && onAction && <button type="button" className="rops-link" onClick={onAction}>{action}</button>}</div>;
}

/** A row of big numbers that wraps to the width it has. */
export type Stat = { key: string; label: string; value: ReactNode; detail?: ReactNode; tone?: string };
export function StatStrip({ items, metrics, min = 132 }: { items: Stat[]; metrics: WidgetMetrics; min?: number }) {
  const columns = Math.max(1, Math.min(items.length, Math.floor((metrics.bodyWidth + 12) / (min + 12))));
  return <div className="ops-stats" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{items.map(item => <div key={item.key} className="ops-stat" data-tone={item.tone}><span className="ops-tile-label">{item.label}</span><strong>{item.value}</strong>{item.detail && <small>{item.detail}</small>}</div>)}</div>;
}

/* ---------- exact decimal-string cents (company APIs) ---------- */

const CENTS = /^-?\d+$/;
/** String cents to a number for charts and sorting; unknown stays undefined. */
export function centsNumber(value: string | null | undefined): number | undefined {
  return typeof value === "string" && CENTS.test(value) ? Number(value) : undefined;
}
/** Sum string cents exactly; any unknown makes the total unknown. */
export function sumCents(values: ReadonlyArray<string | null | undefined>): string | null {
  let total = BigInt(0);
  for (const value of values) { if (typeof value !== "string" || !CENTS.test(value)) return null; total += BigInt(value); }
  return total.toString();
}
/** Whole-dollar text for string or number cents: "$12,340", "−$1,200", "—". */
export function wholeCents(value: string | number | null | undefined): string {
  const number = typeof value === "number" ? value : centsNumber(value ?? undefined);
  return number === undefined || !Number.isFinite(number) ? "—" : formatWholeDollars(number);
}
/** Short money for tight spaces: "$1.2M", "$84K", "$950". */
export function shortCents(value: string | number | null | undefined): string {
  const number = typeof value === "number" ? value : centsNumber(value ?? undefined);
  if (number === undefined || !Number.isFinite(number)) return "—";
  const sign = number < 0 ? "−" : "";
  const abs = Math.abs(number) / 100;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs / 1000)}K`;
  if (abs >= 1_000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}
export const signedCents = (cents: number) => `${cents < 0 ? "−" : "+"}${formatWholeDollars(Math.abs(cents))}`;

/* ---------- dates ---------- */

export function shortDay(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "—";
  const date = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
export function monthShort(key: string): string {
  const date = new Date(`${key.slice(0, 7)}-15T12:00:00`);
  return Number.isNaN(date.getTime()) ? key : date.toLocaleDateString("en-US", { month: "short" });
}
export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to.slice(0, 10)}T12:00:00Z`) - Date.parse(`${from.slice(0, 10)}T12:00:00Z`)) / 86_400_000);
}
export function monthKey(iso: string, offset = 0): string {
  const date = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return date.toISOString().slice(0, 7);
}
export function lastDayOfMonth(month: string): string {
  const date = new Date(`${monthKey(month, 1)}-01T12:00:00Z`);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

/* ---------- charts (inline SVG, sized to the widget body) ---------- */

export type ChartPoint = { label: string; value: number | null; tone?: "critical" | "positive" | "muted" | "accent" };

/** Vertical columns; negative values hang below a zero line. */
export function Columns({ points, width, height, format = value => shortCents(value), showValues = true }: { points: ChartPoint[]; width: number; height: number; format?: (value: number) => string; showValues?: boolean }) {
  const w = Math.max(80, width), h = Math.max(60, height);
  const known = points.map(point => point.value).filter(numeric);
  const max = Math.max(0, ...known), min = Math.min(0, ...known);
  const span = max - min || 1;
  const top = showValues ? 16 : 4, bottom = 18;
  const plot = h - top - bottom;
  const zero = top + plot * (max / span);
  const slot = w / Math.max(1, points.length);
  const bar = Math.max(3, Math.min(28, slot * 0.62));
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(w / 34))));
  return <svg className="ops-chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img">
    <line x1={0} x2={w} y1={zero} y2={zero} className="ops-chart-axis" />
    {points.map((point, index) => {
      const x = index * slot + (slot - bar) / 2;
      if (!numeric(point.value)) return <g key={index}><text x={x + bar / 2} y={zero - 4} className="ops-chart-value is-muted" textAnchor="middle">?</text>{index % labelEvery === 0 && <text x={x + bar / 2} y={h - 4} className="ops-chart-label" textAnchor="middle">{point.label}</text>}</g>;
      const barHeight = Math.max(1, Math.abs(point.value) / span * plot);
      const y = point.value >= 0 ? zero - barHeight : zero;
      const tone = point.tone ?? (point.value < 0 ? "critical" : undefined);
      return <g key={index}><title>{`${point.label}: ${format(point.value)}`}</title>
        <rect x={x} y={y} width={bar} height={barHeight} rx={Math.min(3, bar / 3)} className="ops-chart-bar" data-tone={tone} />
        {showValues && slot > 30 && (point.value >= 0 || y + barHeight + 11 < h - bottom) && <text x={x + bar / 2} y={point.value >= 0 ? y - 4 : y + barHeight + 11} className="ops-chart-value" textAnchor="middle">{format(point.value)}</text>}
        {index % labelEvery === 0 && <text x={x + bar / 2} y={h - 4} className="ops-chart-label" textAnchor="middle">{point.label}</text>}
      </g>;
    })}
  </svg>;
}

/** Paired columns (in vs out) per period. */
export function PairedColumns({ labels, a, b, width, height }: { labels: string[]; a: Array<number | null>; b: Array<number | null>; width: number; height: number }) {
  const w = Math.max(80, width), h = Math.max(60, height);
  const known = [...a, ...b].filter(numeric).map(Math.abs);
  const max = Math.max(1, ...known);
  const bottom = 18, top = 6, plot = h - top - bottom;
  const slot = w / Math.max(1, labels.length);
  const bar = Math.max(2, Math.min(14, slot * 0.34));
  const labelEvery = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(w / 34))));
  return <svg className="ops-chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img">
    <line x1={0} x2={w} y1={top + plot} y2={top + plot} className="ops-chart-axis" />
    {labels.map((label, index) => {
      const x = index * slot + slot / 2;
      const ha = numeric(a[index]) ? Math.abs(a[index] as number) / max * plot : 0;
      const hb = numeric(b[index]) ? Math.abs(b[index] as number) / max * plot : 0;
      return <g key={index}><title>{`${label}: in ${shortCents(a[index])} · out ${shortCents(b[index])}`}</title>
        <rect x={x - bar - 1} y={top + plot - ha} width={bar} height={Math.max(ha, 0.5)} rx={2} className="ops-chart-bar" data-tone="positive" />
        <rect x={x + 1} y={top + plot - hb} width={bar} height={Math.max(hb, 0.5)} rx={2} className="ops-chart-bar" data-tone="critical" />
        {index % labelEvery === 0 && <text x={x} y={h - 4} className="ops-chart-label" textAnchor="middle">{label}</text>}
      </g>;
    })}
  </svg>;
}

/** A line with a soft area; gaps (null) break the line. */
export function LineChart({ points, width, height, format = value => shortCents(value), floor, zeroBased = false }: { points: ChartPoint[]; width: number; height: number; format?: (value: number) => string; floor?: number; zeroBased?: boolean }) {
  const w = Math.max(80, width), h = Math.max(50, height);
  const known = points.map(point => point.value).filter(numeric);
  if (!known.length) return <Empty title="No history yet" />;
  let max = Math.max(...known, floor ?? -Infinity), min = Math.min(...known, floor ?? Infinity);
  if (zeroBased) min = Math.min(0, min);
  if (max === min) { max += 1; min -= 1; }
  const top = 14, bottom = 18, left = 4, right = 4;
  const x = (index: number) => left + (points.length === 1 ? (w - left - right) / 2 : index * (w - left - right) / (points.length - 1));
  const y = (value: number) => top + (max - value) / (max - min) * (h - top - bottom);
  let path = "", area = "", open = false, start = 0;
  points.forEach((point, index) => {
    if (!numeric(point.value)) { if (open) area += `L${x(index - 1)},${h - bottom}L${x(start)},${h - bottom}Z`; open = false; return; }
    path += `${open ? "L" : "M"}${x(index)},${y(point.value)}`;
    if (!open) { start = index; area += `M${x(index)},${h - bottom}L${x(index)},${y(point.value)}`; } else area += `L${x(index)},${y(point.value)}`;
    open = true;
  });
  if (open) area += `L${x(points.length - 1)},${h - bottom}L${x(start)},${h - bottom}Z`;
  const last = [...points].reverse().find(point => numeric(point.value));
  const lastIndex = last ? points.lastIndexOf(last) : -1;
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(w / 40))));
  return <svg className="ops-chart" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img">
    {floor !== undefined && <line x1={0} x2={w} y1={y(floor)} y2={y(floor)} className="ops-chart-floor" />}
    <path d={area} className="ops-chart-area" />
    <path d={path} className="ops-chart-line" />
    {points.map((point, index) => numeric(point.value) ? <circle key={index} cx={x(index)} cy={y(point.value)} r={index === lastIndex ? 3.5 : 2} className="ops-chart-dot" data-tone={point.tone}><title>{`${point.label}: ${format(point.value)}`}</title></circle> : null)}
    {last && lastIndex >= 0 && <text x={Math.min(w - 8, x(lastIndex) - 6)} y={Math.max(11, y(last.value as number) - 7)} className="ops-chart-value" textAnchor="end">{format(last.value as number)}</text>}
    {points.map((point, index) => index % labelEvery === 0 ? <text key={`l${index}`} x={x(index)} y={h - 4} className="ops-chart-label" textAnchor="middle">{point.label}</text> : null)}
  </svg>;
}

/** Progress ring; share is 0..1, undefined draws an empty ring. */
export function Ring({ share, size = 64, label, tone }: { share?: number; size?: number; label?: ReactNode; tone?: "critical" | "positive" | "accent" }) {
  const stroke = Math.max(5, size / 9), radius = (size - stroke) / 2, circumference = 2 * Math.PI * radius;
  const value = share === undefined ? 0 : Math.max(0, Math.min(1, share));
  return <svg className="ops-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
    <circle cx={size / 2} cy={size / 2} r={radius} className="ops-ring-track" strokeWidth={stroke} />
    {share !== undefined && <circle cx={size / 2} cy={size / 2} r={radius} className="ops-ring-fill" data-tone={tone} strokeWidth={stroke} strokeDasharray={`${value * circumference} ${circumference}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} strokeLinecap="round" />}
    <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="ops-ring-text">{label ?? (share === undefined ? "—" : pct(value))}</text>
  </svg>;
}

/** Horizontal stacked bar with a legend. */
export function Stack({ parts, format = value => String(value) }: { parts: Array<{ key: string; label: string; value: number; tone?: string }>; format?: (value: number) => string }) {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0) || 1;
  return <div className="ops-stack"><div className="ops-stack-bar">{parts.map(part => part.value > 0 ? <i key={part.key} data-tone={part.tone} style={{ width: `${part.value / total * 100}%` }} title={`${part.label}: ${format(part.value)}`} /> : null)}</div>
    <ul className="ops-stack-legend">{parts.map(part => <li key={part.key} data-tone={part.tone}><i aria-hidden="true" />{part.label}<strong>{format(part.value)}</strong></li>)}</ul></div>;
}

/** Pages a card between views with dots (the mockup's swipe cards). */
export function Pager({ pages }: { pages: Array<{ key: string; label: string; body: ReactNode }> }) {
  const [index, setIndex] = useState(0);
  useEffect(() => { if (index >= pages.length) setIndex(0); }, [index, pages.length]);
  const page = pages[Math.min(index, pages.length - 1)];
  if (!page) return null;
  return <div className="ops-pager"><div className="ops-pager-body">{page.body}</div>
    <div className="ops-pager-dots" role="tablist" aria-label="Card pages">{pages.map((entry, position) => <button key={entry.key} type="button" role="tab" aria-selected={position === index} aria-label={entry.label} title={entry.label} onClick={() => setIndex(position)} />)}</div></div>;
}

/* ---------- banking guards ---------- */

/** A bank read must be complete before its aggregate can be presented as exact. */
export function bankingNetCents(snapshot: BankingSnapshot): number | undefined {
  if (snapshot.state !== "ready") return undefined;
  const transactions = snapshot.connections.flatMap(connection => connection.transactions).filter(transaction => numeric(transaction.amountCents) && !transaction.pending);
  const inflow = transactions.filter(transaction => (transaction.amountCents as number) < 0).reduce((sum, transaction) => sum - (transaction.amountCents as number), 0);
  const outflow = transactions.filter(transaction => (transaction.amountCents as number) > 0).reduce((sum, transaction) => sum + (transaction.amountCents as number), 0);
  return inflow - outflow;
}

export function bankingStateNotice(state: BankingSnapshot["state"], label = "Bank data") {
  if (state === "partial") return { title: `${label} incomplete`, detail: "Some accounts or transactions could not be read. Totals are withheld until the bank read is complete." };
  if (state === "unavailable") return { title: `${label} unavailable`, detail: "The bank did not provide a complete read. No amount is known until it succeeds." };
  return undefined;
}


/* ---------- record links and grouping over report rows ---------- */

export const propertyLink = (data: DashboardData, row: Row) => <RecordLink kind="property" recordId={String(row.propertyId ?? "")} onOpen={data.onOpenProperty}>{text(row.propertyName)}</RecordLink>;
export const unitLink = (data: DashboardData, row: Row) => <RecordLink kind="unit" recordId={String(row.unitId ?? "")} onOpen={data.onOpenUnit}>{text(row.unitNumber)}</RecordLink>;
export const personLink = (data: DashboardData, row: Row) => <EntityLink personId={String(row.currentPersonId ?? row.personId ?? row.futurePersonId ?? "")} onOpen={data.onOpenTenant}>{text(row.tenantName ?? row.currentTenantName ?? row.futureTenantName)}</EntityLink>;
export const tenantCell = (data: DashboardData, row: Row) => <span className="rops-cell-stack">{personLink(data, row)}<small>{text(row.propertyName)}{row.unitNumber ? ` · ${text(row.unitNumber)}` : ""}</small></span>;
export const unitCell = (data: DashboardData, row: Row, detail?: ReactNode) => <span className="rops-cell-stack">{unitLink(data, row)}<small>{text(row.propertyName)}{detail ? <> · {detail}</> : null}</small></span>;
export const amountColumn = (key: string, label: string): Column => ({ key, label, number: true, render: row => money(row[key]) });

export type Grouped<T> = T & { propertyId: string; propertyName: string };
export function groupByProperty<T extends object>(rows: readonly Row[], seed: () => T, fold: (group: Grouped<T>, row: Row) => void): Grouped<T>[] {
  const groups = new Map<string, Grouped<T>>();
  for (const row of rows) {
    const id = String(row.propertyId ?? row.propertyName ?? "");
    let group = groups.get(id);
    if (!group) { group = { ...seed(), propertyId: id, propertyName: text(row.propertyName) }; groups.set(id, group); }
    fold(group, row);
  }
  return Array.from(groups.values());
}

/** Sum a numeric column; any unknown value makes the sum unknown. */
export const sumKnown = (rows: readonly Row[] | undefined, key: string) => !rows || rows.some(row => !numeric(row[key])) ? undefined : rows.reduce((sum, row) => sum + Number(row[key]), 0);

/** Open a company page from a widget; undefined when the dashboard has no navigation. */
export const companyOpener = (data: DashboardData, section: CompanySection, target?: CompanyTarget) => data.onOpenCompany ? () => data.onOpenCompany!(section, data.organizationId, target) : undefined;

export function humanLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const words = value.replaceAll("_", " ").replaceAll("-", " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
