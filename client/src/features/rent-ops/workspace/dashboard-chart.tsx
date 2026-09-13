import React, { useMemo, useState, type ReactNode } from "react";
import type { DashboardTrends } from "../../../../../shared/rent-ops-dashboard";
import { chartLineSegments, dashboardChartSeries, defaultDashboardMeasure, type TrendMetric, type TrendMeasure } from "./dashboard-model";

const colors = ["#3A3A3C", "#D4A843", "#806A43", "#89898D", "#1C1C1E"];
const dashes = [undefined, undefined, "6 3", "2 3", "8 3 2 3"];
const labels: Record<TrendMetric, string> = { occupancy: "Occupancy Trend", vacancy: "Vacancy Trend", rent: "Rent Roll Trend" };
export function DashboardChart({ metric, data, loading, error, onRetry }: { metric: TrendMetric; data?: DashboardTrends; loading: boolean; error?: string; onRetry: () => void }) {
  const [selected, setSelected] = useState("portfolio");
  const [chosenMeasure, setMeasure] = useState<TrendMeasure | null>(null);
  const measure = chosenMeasure ?? defaultDashboardMeasure(data);
  const [style, setStyle] = useState("line");
  const [hidden, setHidden] = useState<string[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const [valuesOpen, setValuesOpen] = useState(false);
  const properties = data?.months.at(-1)?.properties ?? [];
  const selection = selected === "portfolio" || selected === "compare" || properties.some(property => property.propertyId === selected) ? selected : "portfolio";
  const series = useMemo(() => data ? dashboardChartSeries(data, selection, metric, measure) : [], [data, selection, metric, measure]);
  const visible = series.filter(item => !hidden.includes(item.id));
  const percent = metric !== "rent" && measure === "rate";
  const countLabel = metric === "occupancy" ? "Confirmed occupied units" : "Confirmed vacant units";
  const coverage = (item: typeof series[number], index: number) => item.unknownUnits[index] ? `${item.unknownUnits[index]} units unknown` : "";
  const incompleteOccupancy = data?.months.filter((_, index) => visible.some(item => (item.unknownUnits[index] ?? 0) > 0)).length ?? 0;
  const format = (value: number | null, compact = false) => value === null ? "—" : metric === "rent"
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: compact ? 1 : 2, ...(compact ? { notation: "compact" as const } : {}) }).format(value)
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: percent ? 1 : 0 }).format(value)}${percent ? "%" : ""}`;
  const maximum = percent ? 100 : Math.max(1, ...visible.flatMap(item => item.values.filter((value): value is number => value !== null)));
  const step = percent ? 25 : Math.max(1, 10 ** Math.floor(Math.log10(maximum / 4)));
  const ceiling = percent ? 100 : Math.ceil(maximum / (step * 4)) * step * 4;
  const x = (i: number) => 54 + i * 48;
  const y = (value: number) => 172 - value / ceiling * 138;
  const missing = data?.months.filter((_, index) => visible.some(item => item.values[index] === null)).length ?? 0;
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
    {valuesOpen ? <div className="rmd-table-scroll rmd-chart-values"><table><thead><tr><th>Month</th>{visible.map(item => <th key={item.id} className="number">{item.name}</th>)}</tr></thead><tbody>
      {data.months.map((month, index) => <tr key={month.month}><td>{month.asOfDate}</td>{visible.map(item => <td key={item.id} className="number">{format(item.values[index])}{metric !== "rent" && coverage(item, index) && <small> · {coverage(item, index)}</small>}</td>)}</tr>)}
    </tbody></table></div> : <div className="rmd-chart-scroll">
      <svg className="rmd-chart" viewBox="0 0 640 223" role="img" aria-label={`${labels[metric]}, 12 months ending ${data.asOfDate}`} onMouseLeave={() => setHover(null)}>
        <title>{`${metric !== "rent" && !percent ? countLabel : labels[metric]} — 12 months ending ${data.asOfDate}`}</title>
        {[0, 1, 2, 3, 4].map(tick => <g key={tick}><line x1="54" x2="582" y1={y(tick * ceiling / 4)} y2={y(tick * ceiling / 4)} stroke="#dddcd8" /><text x="47" y={y(tick * ceiling / 4) + 4} textAnchor="end">{format(tick * ceiling / 4, true)}</text></g>)}
        {data.months.map((month, index) => <g key={month.month}><line x1={x(index)} x2={x(index)} y1="34" y2="172" stroke="#eeede9" /><text x={x(index)} y="192" textAnchor="middle">{new Date(`${month.month}-02T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}</text><text x={x(index)} y="207" textAnchor="middle" className="rmd-chart-year">{month.month.slice(0, 4)}</text></g>)}
        {visible.map((item, index) => <g key={item.id}>
          {style === "line" && <path d={chartLineSegments(item.values, x, y)} fill="none" stroke={colors[series.indexOf(item) % colors.length]} strokeWidth="2.1" strokeDasharray={dashes[series.indexOf(item) % dashes.length]} />}
          {item.values.map((value, i) => value === null ? null : style === "bar"
            ? <rect key={i} x={x(i) - 17 + index * 34 / visible.length} y={y(value)} width={Math.max(2, 32 / visible.length)} height={172 - y(value)} fill={colors[series.indexOf(item) % colors.length]} />
            : <circle key={i} cx={x(i)} cy={y(value)} r="3" fill={colors[series.indexOf(item) % colors.length]} />)}
        </g>)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="28" y2="173" stroke="#806A43" strokeDasharray="3 3" />}
        {data.months.map((month, index) => <rect key={month.month} x={x(index) - 22} y="25" width="44" height="150" fill="transparent" tabIndex={0} role="button" aria-label={`${month.asOfDate}: ${visible.map(item => `${item.name} ${format(item.values[index])}${metric !== "rent" && coverage(item, index) ? `, ${coverage(item, index)}` : ""}`).join(", ")}`} onFocus={() => setHover(index)} onBlur={() => setHover(null)} onMouseEnter={() => setHover(index)} onClick={() => setHover(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setHover(index); } }} />)}
      </svg>
    </div>}
    <div className="rmd-chart-readout" aria-live="polite">
      {hover !== null ? <><strong>{data.months[hover].asOfDate}</strong>{metric !== "rent" && !percent && <span>{countLabel}</span>}{visible.map(item => <span key={item.id}>{item.name}: <b>{item.values[hover] === null ? "History incomplete" : format(item.values[hover])}</b>{metric !== "rent" && coverage(item, hover) && <> · {coverage(item, hover)}</>}</span>)}</>
        : <><span>12 months · through {data.asOfDate}</span>{metric !== "rent" && !percent && <span>{countLabel}</span>}{(missing > 0 || incompleteOccupancy > 0) && <span className="rmd-incomplete" title={metric === "rent" ? "Historical charge start dates or billing frequency are missing. Current rent is not backdated." : "Unknown units are excluded from confirmed counts. Percentages require every unit to be known."}>{metric === "rent" ? "Historical charge dates or frequency missing" : percent ? "Percentages unavailable where units are unknown" : "Some months have unknown units · select a month for coverage"}</span>}{loading && <span>Refreshing…</span>}</>}
    </div>
  </>;
  return <section className="rmd-panel rmd-trend-panel" aria-label={labels[metric]}>
    <header className="rmd-panel-header"><h2>{labels[metric]}</h2></header>
    <div className="rmd-chart-filters">
      <select aria-label={`${labels[metric]} property`} value={selection} onChange={event => { setSelected(event.target.value); setHidden([]); setHover(null); }}>
        <option value="portfolio">Portfolio total</option><option value="compare">Compare properties</option>{properties.map(property => <option key={property.propertyId} value={property.propertyId}>{property.propertyName}</option>)}
      </select>
      {metric !== "rent" && <select aria-label={`${labels[metric]} measure`} title="Percentages require complete occupancy history for every unit." value={measure} onChange={event => setMeasure(event.target.value as TrendMeasure)}><option value="rate">Percent</option><option value="units">Units</option></select>}
      <select aria-label={`${labels[metric]} chart type`} value={style} onChange={event => setStyle(event.target.value)}><option value="line">Line</option><option value="bar">Bars</option></select>
    </div>
    {body}
  </section>;
}
