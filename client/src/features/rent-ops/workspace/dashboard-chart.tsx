import React, { useMemo, useState, type ReactNode } from "react";
import type { DashboardTrends } from "../../../../../shared/rent-ops-dashboard";
import { formatLongDate } from "../../../lib/rent-ops-formatters";
import { chartLineSegments, dashboardChartSeries, dashboardTrendPoints, defaultDashboardMeasure, type DashboardTrendPoint, type TrendHistoryMode, type TrendMetric, type TrendMeasure } from "./dashboard-model";

const colors = ["var(--ds-ink-2, #3A3A3C)", "var(--ds-gold, #D4A843)", "#806A43", "var(--ds-faint, #89898D)", "var(--ds-ink, #1C1C1E)"];
const dashes = [undefined, undefined, "6 3", "2 3", "8 3 2 3"];
const labels: Record<TrendMetric, string> = { occupancy: "Occupancy trend", vacancy: "Vacancy trend", rent: "Rent roll trend" };
const metricNames: Record<TrendMetric, string> = { vacancy: "Vacant", occupancy: "Occupied", rent: "Rent roll" };
const DAY = 86_400_000;
const dayValue = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
export function DashboardChart({ metric, data, loading, error, onRetry, onMetric }: { metric: TrendMetric; data?: DashboardTrends; loading: boolean; error?: string; onRetry: () => void; onMetric?: (metric: TrendMetric) => void }) {
  const [selected, setSelected] = useState("portfolio");
  const [chosenMeasure, setMeasure] = useState<TrendMeasure | null>(null);
  const [chosenHistoryMode, setHistoryMode] = useState<TrendHistoryMode | null>(null);
  const hasRecorded = (data?.archivedSnapshots?.length ?? 0) > 0;
  const historyMode = chosenHistoryMode === "recorded" && !hasRecorded
    ? "month_end"
    : chosenHistoryMode ?? (hasRecorded ? "recorded" : "month_end");
  const measure = chosenMeasure ?? defaultDashboardMeasure(data, historyMode, metric);
  const style = "line" as "line" | "bar";
  const [hidden, setHidden] = useState<string[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const [valuesOpen, setValuesOpen] = useState(false);
  const points = data ? dashboardTrendPoints(data, historyMode) : [];
  const properties = points.at(-1)?.properties ?? [];
  const selection = selected === "portfolio" || selected === "compare" || properties.some(property => property.propertyId === selected) ? selected : "portfolio";
  const series = useMemo(() => data ? dashboardChartSeries(data, selection, metric, measure, historyMode) : [], [data, selection, metric, measure, historyMode]);
  const visible = series.filter(item => !hidden.includes(item.id));
  const safeHover = hover !== null && hover < points.length ? hover : null;
  const percent = metric !== "rent" && measure === "rate";
  const countLabel = metric === "occupancy" ? "Confirmed occupied units" : "Confirmed vacant units";
  const coverage = (item: typeof series[number], index: number) => item.unknownUnits[index] ? `${item.unknownUnits[index]} units unknown` : "";
  // Current month-end points expose partial counts for the units view. An
  // archived point carries field-specific knowledge flags and already turns
  // an unknown metric into a null value, so its unrelated unknown bucket must
  // not produce a rent or vacancy warning.
  const partialCurrentUnitPoints = metric !== "rent" && measure === "units"
    ? points.filter((point, index) => point.sourceSystem === undefined && visible.some(item => item.values[index] !== null && (item.unknownUnits[index] ?? 0) > 0)).length
    : 0;
  const sourceLabel = (sourceSystem?: string) => sourceSystem === "rent_manager" ? "RM" : sourceSystem === "appfolio" || sourceSystem === "evernest" ? "Evernest" : undefined;
  const pointLabel = (point: DashboardTrendPoint) => `${formatLongDate(point.asOfDate) ?? point.asOfDate}${sourceLabel(point.sourceSystem) ? ` · ${sourceLabel(point.sourceSystem)}` : ""}`;
  const axisLabel = (point: DashboardTrendPoint) => historyMode === "recorded"
    ? new Date(`${point.asOfDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : new Date(`${point.month}-02T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const format = (value: number | null, compact = false) => value === null ? "—" : metric === "rent"
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: compact ? 1 : 2, ...(compact ? { notation: "compact" as const } : {}) }).format(value)
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: percent ? 1 : 0 }).format(value)}${percent ? "%" : ""}`;
  // Draw only the span that has data, on a time-scaled axis for recorded dates,
  // with a value range fitted to the data (design audit D7).
  const hasValue = (index: number) => visible.some(item => item.values[index] !== null);
  const firstIndex = Math.max(0, points.findIndex((_, index) => hasValue(index)));
  const shown = points.map((_, index) => index).filter(index => index >= firstIndex);
  const values = visible.flatMap(item => item.values.filter((value, index): value is number => value !== null && index >= firstIndex));
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const span = Math.max(high - low, percent ? 10 : metric === "rent" ? Math.max(1, high * 0.1) : 4);
  const rawStep = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= rawStep) ?? 10 * magnitude;
  const floor = Math.max(0, Math.floor((low - step / 2) / step) * step);
  const ceiling = Math.min(percent ? 100 : Infinity, Math.max(floor + step * 4, Math.ceil((high + step / 2) / step) * step));
  const ticks = Array.from({ length: Math.round((ceiling - floor) / step) + 1 }, (_, tick) => floor + tick * step).filter(value => value <= ceiling + 1e-9);
  const chartWidth = Math.max(640, 640 + Math.max(0, shown.length - 12) * 48);
  const timeScaled = historyMode === "recorded" && shown.length > 1;
  const startDay = timeScaled ? dayValue(points[firstIndex].asOfDate) : 0;
  const endDay = timeScaled ? dayValue(points[points.length - 1].asOfDate) : 0;
  const x = (i: number) => {
    if (shown.length <= 1) return 54;
    if (timeScaled && endDay > startDay) return 54 + (dayValue(points[i].asOfDate) - startDay) / (endDay - startDay) * (chartWidth - 112);
    return 54 + (i - firstIndex) * (chartWidth - 112) / (shown.length - 1);
  };
  const y = (value: number) => 172 - (value - floor) / (ceiling - floor || 1) * 138;
  const labelEvery = Math.max(1, Math.ceil(shown.length / 8));
  const lastIndex = points.length - 1;
  const endpoint = visible[0] && visible[0].values[lastIndex] !== null ? visible[0].values[lastIndex] : null;
  void DAY;
  const missing = points.filter((_, index) => visible.some(item => item.values[index] === null)).length;
  const incomplete = missing > 0 || partialCurrentUnitPoints > 0;
  let body: ReactNode;
  if (error) body = <div className="rmd-message" role="alert">History could not be loaded. <button onClick={onRetry}>Retry</button></div>;
  else if (!data) body = <div className="rmd-message" role="status">Loading 12-month history…</div>;
  else if (!properties.length) body = <div className="rmd-message">No units in the selected properties.</div>;
  else body = <>
    <div className="rmd-chart-legend" aria-label={`${labels[metric]} series`}>
      {series.map((item, index) => <button key={item.id} type="button" aria-pressed={!hidden.includes(item.id)} onClick={() => setHidden(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}>
        <i style={{ background: colors[index % colors.length] }} />{item.name}
      </button>)}
      <button className="rmd-values-toggle" type="button" aria-expanded={valuesOpen} onClick={() => setValuesOpen(open => !open)}>{valuesOpen ? "Chart" : "Values"}</button>
    </div>
    {valuesOpen ? <div className="rmd-table-scroll rmd-chart-values"><table><thead><tr><th>{historyMode === "recorded" ? "Date" : "Month"}</th>{visible.map(item => <th key={item.id} className="number">{item.name}</th>)}</tr></thead><tbody>
      {points.map((point, index) => <tr key={`${point.asOfDate}:${point.sourceSystem ?? "current"}`}><td>{pointLabel(point)}</td>{visible.map(item => <td key={item.id} className="number">{format(item.values[index])}{metric !== "rent" && coverage(item, index) && <small> · {coverage(item, index)}</small>}</td>)}</tr>)}
    </tbody></table></div> : <div className="rmd-chart-scroll">
      <svg className="rmd-chart" viewBox={`0 0 ${chartWidth} 223`} role="img" aria-label={`${labels[metric]}, ${historyMode === "recorded" ? `${points.length} recorded dates through` : "12 months ending"} ${data.asOfDate}`} onMouseLeave={() => setHover(null)}>
        <title>{`${metric !== "rent" && !percent ? countLabel : labels[metric]} — ${historyMode === "recorded" ? `${points.length} recorded dates through` : "12 months ending"} ${data.asOfDate}`}</title>
        {ticks.map(tick => <g key={tick}><line x1="54" x2={chartWidth - 58} y1={y(tick)} y2={y(tick)} style={{ stroke: "var(--ds-table-hairline, #dddcd8)" }} /><text x="47" y={y(tick) + 4} textAnchor="end">{format(tick, true)}</text></g>)}
        {points.map((point, index) => index < firstIndex ? null : <g key={`${point.asOfDate}:${point.sourceSystem ?? "current"}`}>{((index - firstIndex) % labelEvery === 0 || index === lastIndex) && <><text x={x(index)} y="192" textAnchor={index === lastIndex && shown.length > 1 ? "end" : index === firstIndex && shown.length > 1 ? "start" : "middle"}>{axisLabel(point)}</text>{(index === firstIndex || point.asOfDate.slice(0, 4) !== points[Math.max(firstIndex, index - labelEvery)]?.asOfDate.slice(0, 4)) && <text x={x(index)} y="207" textAnchor={index === lastIndex && shown.length > 1 ? "end" : index === firstIndex && shown.length > 1 ? "start" : "middle"} className="rmd-chart-year">{point.asOfDate.slice(0, 4)}</text>}</>}</g>)}
        <line x1="54" x2={chartWidth - 58} y1="172" y2="172" style={{ stroke: "var(--ds-hairline-strong, #cfcac0)" }} />
        {visible.map((item, index) => <g key={item.id}>
          {style === "line" && <path d={chartLineSegments(item.values.map((value, i) => i < firstIndex ? null : value), x, y)} fill="none" style={{ stroke: colors[series.indexOf(item) % colors.length] }} strokeWidth="2.1" strokeDasharray={dashes[series.indexOf(item) % dashes.length]} />}
          {item.values.map((value, i) => value === null ? null : style === "bar"
            ? <rect key={i} x={x(i) - 17 + index * 34 / visible.length} y={y(value)} width={Math.max(2, 32 / visible.length)} height={172 - y(value)} style={{ fill: colors[series.indexOf(item) % colors.length] }} />
            : i < firstIndex ? null : <circle key={i} cx={x(i)} cy={y(value)} r={i === lastIndex && index === 0 ? 4.5 : 3} style={{ fill: i === lastIndex && index === 0 ? "var(--ds-gold, #D4A843)" : colors[series.indexOf(item) % colors.length] }} />)}
        </g>)}
        {endpoint !== null && <text className="rmd-chart-endpoint" x={x(lastIndex) < 160 ? x(lastIndex) + 8 : x(lastIndex) - 8} y={y(endpoint) - 10} textAnchor={x(lastIndex) < 160 ? "start" : "end"}>{format(endpoint)}{metric === "vacancy" && !percent ? " vacant" : metric === "occupancy" && !percent ? " occupied" : ""}</text>}
        {safeHover !== null && <line x1={x(safeHover)} x2={x(safeHover)} y1="28" y2="173" style={{ stroke: "var(--ds-gold-ink, #806A43)" }} strokeDasharray="3 3" />}
        {points.map((point, index) => <rect key={`${point.asOfDate}:${point.sourceSystem ?? "current"}`} x={x(index) - 22} y="25" width="44" height="150" fill="transparent" tabIndex={0} role="button" aria-label={`${pointLabel(point)}: ${visible.map(item => `${item.name} ${format(item.values[index])}${metric !== "rent" && coverage(item, index) ? `, ${coverage(item, index)}` : ""}`).join(", ")}`} onFocus={() => setHover(index)} onBlur={() => setHover(null)} onMouseEnter={() => setHover(index)} onClick={() => setHover(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setHover(index); } }} />)}
      </svg>
    </div>}
    <div className="rmd-chart-readout" aria-live="polite">
      {safeHover !== null ? <><strong>{pointLabel(points[safeHover])}</strong>{metric !== "rent" && !percent && <span>{countLabel}</span>}{visible.map(item => <span key={item.id}>{item.name}: <b>{item.values[safeHover] === null ? "History incomplete" : format(item.values[safeHover])}</b>{metric !== "rent" && coverage(item, safeHover) && <> · {coverage(item, safeHover)}</>}</span>)}</>
        : <><span>{historyMode === "recorded" ? `${points.length} recorded dates` : "12 months"} · through {formatLongDate(data.asOfDate) ?? data.asOfDate}</span>{metric !== "rent" && !percent && <span>{countLabel}</span>}{incomplete && <span className="rmd-incomplete" title={metric === "rent" ? "Historical charge start dates or billing frequency are missing. Current rent is not backdated." : "Unknown units are excluded from confirmed counts. Percentages require every unit to be known."}>{metric === "rent" ? "Historical charge dates or frequency missing" : percent ? "Percentages unavailable where units are unknown" : historyMode === "recorded" ? "Some recorded dates have unknown units · select a date for coverage" : "Some months have unknown units · select a month for coverage"}</span>}{loading && <span>Refreshing…</span>}</>}
    </div>
  </>;
  return <section className="rmd-panel rmd-trend-panel" aria-label={labels[metric]}>
    <header className="rmd-panel-header">{onMetric ? <><h2 className="rmd-visually-hidden">Trends</h2><div className="rmd-metric-switch" role="group" aria-label="Trend">{(["vacancy", "occupancy", "rent"] as const).map(option => <button key={option} type="button" aria-pressed={option === metric} onClick={() => { onMetric(option); setHover(null); setHidden([]); }}>{metricNames[option]}</button>)}</div></> : <h2>{labels[metric]}</h2>}</header>
    <div className="rmd-chart-filters">
      {hasRecorded && <select className="rmd-history-mode" aria-label={`${labels[metric]} history mode`} value={historyMode} onChange={event => { setHistoryMode(event.target.value as TrendHistoryMode); setHidden([]); setHover(null); }}><option value="recorded">Recorded dates</option><option value="month_end">Month end</option></select>}
      <select className="rmd-property-selector" aria-label={`${labels[metric]} property`} value={selection} onChange={event => { setSelected(event.target.value); setHidden([]); setHover(null); }}>
        <option value="portfolio">Portfolio total</option><option value="compare">Compare properties</option>{properties.map(property => <option key={property.propertyId} value={property.propertyId}>{property.propertyName}</option>)}
      </select>
      {metric !== "rent" && <select aria-label={`${labels[metric]} measure`} title="Percentages require complete occupancy history for every unit." value={measure} onChange={event => setMeasure(event.target.value as TrendMeasure)}><option value="rate">Percent</option><option value="units">Units</option></select>}
    </div>
    {body}
  </section>;
}
