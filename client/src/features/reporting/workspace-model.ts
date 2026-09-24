import type { ReportPackageItem, ReportPackageRun, ReportRunRequest, ReportingRuntimeStatus } from "@shared/reporting";

export type PackageDraftItem = Omit<ReportPackageItem, "id"> & { readonly id?: string; readonly title?: string };
export interface PackageDraft {
  readonly id?: string;
  readonly revision?: number;
  readonly name: string;
  readonly visibility: "private" | "shared";
  readonly items: readonly PackageDraftItem[];
}

export function runtimeStatusLabel(status: ReportingRuntimeStatus): string {
  if (status === "available") return "Available";
  if (status === "missing_data") return "Missing data";
  return "Not implemented";
}

/** A package item freezes the exact executed request of the current report. */
export function packageItemFromRequest(request: ReportRunRequest, title: string, existing: readonly PackageDraftItem[]): PackageDraftItem {
  const used = new Set(existing.map(item => item.id).filter(Boolean));
  let index = existing.length + 1;
  let id = `${request.reportId}-${index}`;
  while (used.has(id)) { index += 1; id = `${request.reportId}-${index}`; }
  return {
    id, title, reportId: request.reportId, definitionVersion: request.definitionVersion, scope: request.scope, filters: request.filters, period: request.period,
    basis: request.basis, currency: request.currency, consolidation: request.consolidation ?? null, forecast: request.forecast ?? null, columns: request.columns ? [...request.columns] : [], sort: request.sort ? [...request.sort] : [],
  };
}

/** A package run is complete only when every item ran with complete coverage. */
export function packageRunSummary(run: ReportPackageRun): { readonly complete: boolean; readonly label: string } {
  const failed = run.itemRuns.filter(item => item.state === "failed").length;
  const incomplete = run.itemRuns.filter(item => item.state !== "failed" && item.completeness !== "complete").length;
  const complete = run.completeness === "complete" && failed === 0 && incomplete === 0;
  if (complete) return { complete, label: `All ${run.itemRuns.length} reports complete` };
  const parts = [failed ? `${failed} failed` : null, incomplete ? `${incomplete} incomplete` : null].filter(Boolean);
  return { complete, label: `Package incomplete: ${parts.join(", ") || "completeness not recorded"}` };
}

/** Keep legacy package runs with no row count visibly unknown instead of treating them as zero. */
export function packageRunRowCount(items: readonly { readonly rowCount?: number }[]): { readonly knownRows: number; readonly unknownCount: number } {
  return {
    knownRows: items.reduce((total, item) => total + (item.rowCount ?? 0), 0),
    unknownCount: items.filter(item => item.rowCount === undefined).length,
  };
}

/** The part of `window.open` the print action needs. */
export type OpenWindow = (url: string, target: string) => { opener: unknown } | null;

/**
 * Opens the printable export in a new tab. `noopener` would make
 * `window.open` return null even on success, so the tab is opened normally
 * and its opener is cleared. Returns false only when the tab was blocked,
 * which is the one case that should fall back to a download.
 */
export function openPrintView(open: OpenWindow, url: string): boolean {
  const view = open(url, "_blank");
  if (!view) return false;
  try { view.opener = null; } catch { /* cross-origin view; opener already unreachable */ }
  return true;
}
