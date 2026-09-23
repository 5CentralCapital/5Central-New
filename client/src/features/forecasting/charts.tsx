import React from "react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { chartDollars, compactDollars, dateLabel, monthLabel } from "./format";

/**
 * Inline SVG charts. Geometry uses Number dollars for pixels only; every
 * figure a person reads comes from the exact tables beside the chart. Few
 * colors: ink for the primary series, gold as the single accent, muted for
 * context and reference lines. Every mark that carries a value is a keyboard
 * reachable button that opens its drilldown.
 */
export interface Scale { readonly min: number; readonly max: number; readonly ticks: readonly number[]; y(value: number): number }

/** Nice rounded ticks that always include zero when the range crosses it. */
export function niceScale(values: readonly number[], top: number, bottom: number, count = 4): Scale {
  const finite = values.filter(value => Number.isFinite(value));
  let min = Math.min(0, ...finite);
  let max = Math.max(0, ...finite);
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= raw) ?? raw;
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = min; value <= max + step / 2; value += step) ticks.push(Math.round(value / step) * step);
  return { min, max, ticks, y: value => bottom - ((value - min) / (max - min)) * (bottom - top) };
}

function activate(handler: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handler(); }
  };
}

const WIDTH = 720;

/**
 * Draw charts at their rendered width so text and strokes stay at their CSS
 * size instead of scaling with the viewBox on wide screens.
 */
function useChartWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const update = () => { const next = Math.round(element.getBoundingClientRect().width); if (next > 0) setWidth(Math.max(320, next)); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
const HEIGHT = 240;
const LEFT = 64;
const RIGHT = 84;
const TOP = 16;
const BOTTOM = 204;

function Axis({ scale, width = WIDTH, format = compactDollars }: { scale: Scale; width?: number; format?: (value: number) => string }) {
  return <g className="fc-axis" aria-hidden="true">
    {scale.ticks.map(tick => <g key={tick}>
      <line x1={LEFT} x2={width - RIGHT} y1={scale.y(tick)} y2={scale.y(tick)} className={tick === 0 ? "fc-grid fc-grid--zero" : "fc-grid"} />
      <text x={LEFT - 8} y={scale.y(tick)} dy="0.32em" textAnchor="end">{format(tick)}</text>
    </g>)}
  </g>;
}

export interface LineSeries {
  readonly id: string;
  readonly label: string;
  readonly tone: "ink" | "gold" | "muted";
  readonly dashed?: boolean;
  readonly values: readonly (string | null)[];
}

/** Multi-series line chart over period keys, with a reserve-floor reference and direct end labels. */
export function LineChart({ title, periods, series, floorCents, periodLabel = dateLabel, onSelect, selectedKey, footer }: {
  title: string;
  periods: readonly { key: string; label: string }[];
  series: readonly LineSeries[];
  floorCents?: string;
  periodLabel?: (label: string) => string;
  onSelect?: (seriesId: string, periodKey: string) => void;
  selectedKey?: string;
  footer?: ReactNode;
}) {
  const titleId = useId();
  const [figureRef, w] = useChartWidth();
  const floor = floorCents === undefined ? null : chartDollars(floorCents);
  const numeric = series.map(item => item.values.map(value => (value === null ? null : chartDollars(value))));
  const scale = niceScale([...numeric.flat().filter((value): value is number => value !== null), ...(floor === null ? [] : [floor])], TOP, BOTTOM);
  const x = (index: number) => (periods.length <= 1 ? (LEFT + w - RIGHT) / 2 : LEFT + (index * (w - RIGHT - LEFT)) / (periods.length - 1));
  const labelEvery = Math.max(1, Math.ceil(periods.length / 7));
  // Direct end labels: keep at least 14px apart so neighbouring series never overlap.
  const endLabelY = series.map((_, index) => { const values = numeric[index]!; const last = [...values].reverse().find(value => value !== null); return last === undefined || last === null ? 0 : scale.y(last); });
  const order = endLabelY.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k += 1) if (order[k]!.y - order[k - 1]!.y < 14) { order[k]!.y = order[k - 1]!.y + 14; endLabelY[order[k]!.index] = order[k]!.y; }
  return <figure ref={figureRef as React.RefObject<HTMLElement>} className="fc-chart" aria-labelledby={titleId}>
    <figcaption id={titleId} className="fc-chart-title">{title}</figcaption>
    <svg viewBox={`0 0 ${w} ${HEIGHT}`} role="img" aria-label={`${title}. Values are listed in the table below.`} preserveAspectRatio="xMidYMid meet">
      <Axis scale={scale} width={w} />
      {floor !== null && <g className="fc-floor">
        <line x1={LEFT} x2={w - RIGHT} y1={scale.y(floor)} y2={scale.y(floor)} />
        <text x={w - RIGHT + 6} y={scale.y(floor)} dy="0.32em">Reserve floor</text>
      </g>}
      {periods.map((period, index) => index % labelEvery === 0 && <text key={period.key} className="fc-axis-label" x={x(index)} y={BOTTOM + 18} textAnchor="middle" aria-hidden="true">{periodLabel(period.label)}</text>)}
      {series.map((item, seriesIndex) => {
        const points = numeric[seriesIndex]!.map((value, index) => (value === null ? null : `${x(index)},${scale.y(value)}`));
        const path = points.reduce<string>((text, point) => (point === null ? text : `${text}${text ? " L" : "M"}${point}`), "");
        const lastIndex = numeric[seriesIndex]!.map((value, index) => (value === null ? -1 : index)).reduce((a, b) => Math.max(a, b), -1);
        return <g key={item.id} className={`fc-series fc-series--${item.tone}${item.dashed ? " fc-series--dashed" : ""}`}>
          <path d={path} />
          {lastIndex >= 0 && <text className="fc-direct-label" x={x(lastIndex) + 8} y={endLabelY[seriesIndex]} dy="0.32em">{item.label}</text>}
          {numeric[seriesIndex]!.map((value, index) => value === null || (periods[index]!.key !== selectedKey && index !== lastIndex) ? null : <circle key={periods[index]!.key} cx={x(index)} cy={scale.y(value)} r={periods[index]!.key === selectedKey ? 4 : 2.5}
            className={floor !== null && item.id === "available" && value < floor ? "fc-point fc-point--low" : "fc-point"} />)}
        </g>;
      })}
      {onSelect && periods.map((period, index) => {
        const width = periods.length <= 1 ? w - LEFT - RIGHT : (w - RIGHT - LEFT) / (periods.length - 1);
        const primary = series[0];
        return <rect key={period.key} className="fc-hit" x={x(index) - width / 2} y={TOP} width={width} height={BOTTOM - TOP} role="button" tabIndex={0}
          aria-label={`${periodLabel(period.label)}: show what makes up ${primary?.label.toLowerCase() ?? "this value"}`}
          onClick={() => onSelect(primary?.id ?? "", period.key)} onKeyDown={activate(() => onSelect(primary?.id ?? "", period.key))} />;
      })}
    </svg>
    {footer}
  </figure>;
}

export interface WaterfallStep { readonly key: string; readonly label: string; readonly cents: string }

/** Cash bridge: opening, signed movements by category, closing. */
export function WaterfallChart({ title, openingCents, closingCents, steps, onSelect }: {
  title: string; openingCents: string; closingCents: string; steps: readonly WaterfallStep[]; onSelect?: (key: string) => void;
}) {
  const titleId = useId();
  const [figureRef, w] = useChartWidth();
  const bars: { key: string; label: string; from: number; to: number; kind: "total" | "up" | "down"; clickable: boolean }[] = [];
  let running = chartDollars(openingCents);
  bars.push({ key: "opening", label: "Opening", from: 0, to: running, kind: "total", clickable: false });
  for (const step of steps) {
    const next = running + chartDollars(step.cents);
    bars.push({ key: step.key, label: step.label, from: running, to: next, kind: next >= running ? "up" : "down", clickable: true });
    running = next;
  }
  bars.push({ key: "closing", label: "Closing", from: 0, to: chartDollars(closingCents), kind: "total", clickable: false });
  const scale = niceScale(bars.flatMap(bar => [bar.from, bar.to]), TOP, BOTTOM);
  const slot = (w - LEFT - 24) / bars.length;
  return <figure ref={figureRef as React.RefObject<HTMLElement>} className="fc-chart" aria-labelledby={titleId}>
    <figcaption id={titleId} className="fc-chart-title">{title}</figcaption>
    <svg viewBox={`0 0 ${w} ${HEIGHT + 24}`} role="img" aria-label={`${title}. Values are listed beside the chart.`}>
      <Axis scale={scale} width={w} />
      {bars.map((bar, index) => {
        const top = scale.y(Math.max(bar.from, bar.to));
        const height = Math.max(1, Math.abs(scale.y(bar.from) - scale.y(bar.to)));
        const left = LEFT + index * slot + slot * 0.18;
        const handler = bar.clickable && onSelect ? () => onSelect(bar.key) : undefined;
        return <g key={bar.key} className={`fc-bar fc-bar--${bar.kind}`}>
          <rect x={left} y={top} width={slot * 0.64} height={height} rx={2}
            {...(handler ? { role: "button", tabIndex: 0, "aria-label": `${bar.label}: show contributing events`, onClick: handler, onKeyDown: activate(handler), className: "fc-bar-hit" } : {})} />
          <text className="fc-axis-label" x={left + slot * 0.32} y={BOTTOM + 18} textAnchor="middle" aria-hidden="true">{bar.label.length > 11 ? `${bar.label.slice(0, 10)}…` : bar.label}</text>
        </g>;
      })}
    </svg>
  </figure>;
}

/** Monthly bars (e.g. NOI) with an optional percentage line on a right axis (e.g. occupancy). */
export function BarLineChart({ title, months, bars, barLabel, line, lineLabel, onSelect }: {
  title: string; months: readonly string[]; bars: readonly (string | null)[]; barLabel: string;
  line?: readonly (number | null)[]; lineLabel?: string; onSelect?: (monthIndex: number) => void;
}) {
  const titleId = useId();
  const [figureRef, w] = useChartWidth();
  const values = bars.map(value => (value === null ? 0 : chartDollars(value)));
  const scale = niceScale(values, TOP, BOTTOM);
  const slot = (w - LEFT - RIGHT) / Math.max(1, months.length);
  const percentY = (bps: number) => BOTTOM - (bps / 10_000) * (BOTTOM - TOP);
  const labelEvery = Math.max(1, Math.ceil(months.length / 12));
  const linePath = line?.reduce((text, bps, index) => (bps === null ? text : `${text}${text ? " L" : "M"}${LEFT + index * slot + slot / 2},${percentY(bps)}`), "") ?? "";
  return <figure ref={figureRef as React.RefObject<HTMLElement>} className="fc-chart" aria-labelledby={titleId}>
    <figcaption id={titleId} className="fc-chart-title">{title}</figcaption>
    <svg viewBox={`0 0 ${w} ${HEIGHT}`} role="img" aria-label={`${title}. Values are listed in the table below.`}>
      <Axis scale={scale} width={w} />
      {line && <g className="fc-axis" aria-hidden="true">
        {[0, 5_000, 10_000].map(bps => <text key={bps} x={w - RIGHT + 8} y={percentY(bps)} dy="0.32em">{bps / 100}%</text>)}
      </g>}
      {values.map((value, index) => {
        const top = scale.y(Math.max(0, value));
        const height = Math.max(1, Math.abs(scale.y(0) - scale.y(value)));
        const handler = onSelect ? () => onSelect(index) : undefined;
        return <g key={months[index]} className={`fc-bar ${value < 0 ? "fc-bar--down" : "fc-bar--total"}`}>
          <rect x={LEFT + index * slot + slot * 0.18} y={top} width={slot * 0.64} height={height} rx={1.5}
            {...(handler ? { role: "button", tabIndex: 0, "aria-label": `${monthLabel(months[index]!, true)} ${barLabel}: show contributing events`, onClick: handler, onKeyDown: activate(handler), className: "fc-bar-hit" } : {})} />
          {index % labelEvery === 0 && <text className="fc-axis-label" x={LEFT + index * slot + slot / 2} y={BOTTOM + 18} textAnchor="middle" aria-hidden="true">{monthLabel(months[index]!)}</text>}
        </g>;
      })}
      {line && <g className="fc-series fc-series--gold"><path d={linePath} />
        {lineLabel && <text className="fc-direct-label" x={w - RIGHT} y={TOP - 4} textAnchor="end">{lineLabel}</text>}</g>}
      <text className="fc-direct-label" x={LEFT} y={TOP - 4}>{barLabel}</text>
    </svg>
  </figure>;
}

/** Debt maturity ladder: balloons maturing by year and scheduled principal. */
export function LadderChart({ title, rows, onSelect, selectedYear }: { title: string; rows: readonly { year: string; maturingCents: string; scheduledPrincipalCents: string }[]; onSelect?: (year: string) => void; selectedYear?: string }) {
  const titleId = useId();
  const [figureRef, w] = useChartWidth();
  const scale = niceScale(rows.map(row => chartDollars(row.maturingCents) + chartDollars(row.scheduledPrincipalCents)), TOP, BOTTOM);
  const slot = (w - LEFT - RIGHT) / Math.max(1, rows.length);
  return <figure ref={figureRef as React.RefObject<HTMLElement>} className="fc-chart" aria-labelledby={titleId}>
    <figcaption id={titleId} className="fc-chart-title">{title}</figcaption>
    <svg viewBox={`0 0 ${w} ${HEIGHT}`} role="img" aria-label={`${title}. Values are listed in the table below.`}>
      <Axis scale={scale} width={w} />
      {rows.map((row, index) => {
        const scheduled = chartDollars(row.scheduledPrincipalCents);
        const maturing = chartDollars(row.maturingCents);
        const left = LEFT + index * slot + slot * 0.2;
        const width = slot * 0.6;
        const handler = onSelect ? () => onSelect(row.year) : undefined;
        return <g key={row.year} className={row.year === selectedYear ? "fc-ladder is-selected" : "fc-ladder"}>
          {handler && <rect className="fc-hit" x={left - slot * 0.1} y={TOP} width={width + slot * 0.2} height={BOTTOM - TOP} role="button" tabIndex={0}
            aria-label={`${row.year}: show loan payments`} onClick={handler} onKeyDown={activate(handler)} />}
          <rect className="fc-stack fc-stack--muted" x={left} y={scale.y(scheduled)} width={width} height={Math.max(0, scale.y(0) - scale.y(scheduled))} />
          <rect className="fc-stack fc-stack--ink" x={left} y={scale.y(scheduled + maturing)} width={width} height={Math.max(0, scale.y(scheduled) - scale.y(scheduled + maturing))} />
          <text className="fc-axis-label" x={left + width / 2} y={BOTTOM + 18} textAnchor="middle" aria-hidden="true">{row.year}</text>
        </g>;
      })}
      <g className="fc-legend-inline" aria-hidden="true">
        <rect className="fc-stack fc-stack--ink" x={w - RIGHT + 8} y={TOP} width={10} height={10} /><text x={w - RIGHT + 22} y={TOP + 9}>Maturing</text>
        <rect className="fc-stack fc-stack--muted" x={w - RIGHT + 8} y={TOP + 18} width={10} height={10} /><text x={w - RIGHT + 22} y={TOP + 27}>Amortizing</text>
      </g>
    </svg>
  </figure>;
}

export interface CompositionPart { readonly key: string; readonly label: string; readonly cents: string }

/** Two stacked bars: what the company owns against who has a claim on it. */
export function CompositionChart({ title, assets, claims, onSelect }: { title: string; assets: readonly CompositionPart[]; claims: readonly CompositionPart[]; onSelect?: (key: string) => void }) {
  const titleId = useId();
  const [figureRef, w] = useChartWidth();
  const total = Math.max(1, assets.reduce((sum, part) => sum + Math.max(0, chartDollars(part.cents)), 0), claims.reduce((sum, part) => sum + Math.max(0, chartDollars(part.cents)), 0));
  const tones = ["ink", "ink-2", "muted", "faint", "gold"];
  const row = (parts: readonly CompositionPart[], y: number, label: string) => {
    let offset = LEFT + 70;
    const width = w - LEFT - 70 - 24;
    return <g>
      <text className="fc-axis-label" x={LEFT + 62} y={y + 14} textAnchor="end">{label}</text>
      {parts.filter(part => chartDollars(part.cents) > 0).map((part, index) => {
        const size = (chartDollars(part.cents) / total) * width;
        const x = offset;
        offset += size;
        const handler = onSelect ? () => onSelect(part.key) : undefined;
        return <rect key={part.key} className={`fc-stack fc-stack--${tones[index % tones.length]}`} x={x} y={y} width={Math.max(0, size - 1)} height={28}
          {...(handler ? { role: "button", tabIndex: 0, "aria-label": `${part.label}: show rollforward`, onClick: handler, onKeyDown: activate(handler) } : {})}><title>{part.label}</title></rect>;
      })}
    </g>;
  };
  return <figure ref={figureRef as React.RefObject<HTMLElement>} className="fc-chart" aria-labelledby={titleId}>
    <figcaption id={titleId} className="fc-chart-title">{title}</figcaption>
    <svg viewBox={`0 0 ${w} 96`} role="img" aria-label={`${title}. Values are listed in the table below.`}>
      {row(assets, 8, "Assets")}
      {row(claims, 52, "Claims")}
    </svg>
  </figure>;
}
