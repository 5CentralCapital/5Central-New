import type { ReactNode } from "react";
import {
  formatExactCents,
  type ExactCentsSummary,
} from "./list-totals-model";

export interface ListTotalsMetric {
  label: string;
  value: ReactNode;
}
export interface ListTotalsProps {
  totalCount: number;
  /** Count after search/filter, before pagination. */
  visibleCount?: number;
  /** Forces filtered wording when a filter is active but matches every row. */
  filtered?: boolean;
  itemLabel?: string;
  metrics?: readonly ListTotalsMetric[];
  className?: string;
}

function pluralize(label: string, count: number): string {
  return `${label}${count === 1 ? "" : "s"}`;
}

export function exactCentsMetric(label: string, summary: ExactCentsSummary): ListTotalsMetric {
  const value = summary.total === null
    ? `Unknown${summary.unknownCount ? ` · ${summary.unknownCount} unresolved` : ""}`
    : formatExactCents(summary.total);
  return { label, value };
}

/** Compact, screen-reader friendly footer shared by operational lists. */
export function ListTotals({
  totalCount,
  visibleCount = totalCount,
  filtered = visibleCount !== totalCount,
  itemLabel = "record",
  metrics = [],
  className,
}: ListTotalsProps): JSX.Element {
  const normalizedTotal = Number.isFinite(totalCount) ? Math.max(0, Math.floor(totalCount)) : 0;
  const normalizedVisible = Number.isFinite(visibleCount) ? Math.max(0, Math.floor(visibleCount)) : 0;
  const countText = filtered
    ? `Filtered view · ${normalizedVisible} of ${normalizedTotal} ${pluralize(itemLabel, normalizedTotal)}`
    : `${normalizedTotal} ${pluralize(itemLabel, normalizedTotal)}`;
  return (
    <footer className={`rm-list-totals${className ? ` ${className}` : ""}`} aria-label={`${itemLabel} totals`}>
      <span className="rm-list-totals-count" aria-live="polite">{countText}</span>
      {metrics.length > 0 && (
        <dl className="rm-list-totals-metrics">
          {metrics.map((metric) => (
            <div key={metric.label}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </footer>
  );
}
