import * as React from "react";
import { useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { formatDate, formatLabel, formatMoney } from "./display";
import {
  clampGridPage,
  DEFAULT_GRID_PAGE_SIZE,
  filterGridRows,
  getGridPageCount,
  paginateGridRows,
  sortGridRows,
  type GridColumn,
  type GridSortDirection,
  type GridSortState,
} from "./grid-model";

export type { GridColumn } from "./grid-model";

const NEEDS_REVIEW = "Needs review";

export interface DataGridProps<T extends object> {
  rows: T[];
  columns: GridColumn<T>[];
  getRowKey?: (row: T, index: number) => string;
  onRow?: (row: T) => void;
  emptyMessage?: string;
  pageSize?: number;
  search?: string;
  caption?: string;
  initialSort?: GridSortState;
  storageKey?: string;
}

function preferenceStorageKey(storageKey: string | undefined): string | undefined {
  const trimmed = storageKey?.trim();
  return trimmed || undefined;
}

function columnSignature<T extends object>(columns: readonly GridColumn<T>[]): string {
  return columns.map((column) => `${column.key}:${column.hidden ? "hidden" : "shown"}`).join("\u001f");
}

interface StoredColumnPreferences {
  known: string[];
  hidden: string[];
}

function readColumnPreferences<T extends object>(
  storageKey: string | undefined,
  columns: readonly GridColumn<T>[],
): Set<string> {
  const defaults = new Set(columns.filter((column) => column.hidden).map((column) => column.key));
  if (!storageKey || typeof window === "undefined") return defaults;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return defaults;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((key): key is string => typeof key === "string" && columns.some((column) => column.key === key)));
    }
    if (!parsed || typeof parsed !== "object") return defaults;
    const candidate = parsed as Partial<StoredColumnPreferences>;
    if (!Array.isArray(candidate.hidden)) return defaults;

    const known = Array.isArray(candidate.known) ? candidate.known.filter((key): key is string => typeof key === "string") : [];
    const hidden = new Set(candidate.hidden.filter((key): key is string => typeof key === "string"));
    return new Set(
      columns
        .filter((column) => (known.includes(column.key) ? hidden.has(column.key) : Boolean(column.hidden)))
        .map((column) => column.key),
    );
  } catch {
    // Browsers can deny localStorage access in private or embedded contexts.
    return defaults;
  }
}

function writeColumnPreferences<T extends object>(
  storageKey: string | undefined,
  columns: readonly GridColumn<T>[],
  hidden: ReadonlySet<string>,
): void {
  if (!storageKey || typeof window === "undefined") return;
  try {
    const value: StoredColumnPreferences = {
      known: columns.map((column) => column.key),
      hidden: columns.filter((column) => hidden.has(column.key)).map((column) => column.key),
    };
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Preferences are optional; a storage failure must not affect the grid.
  }
}

function defaultRowKey<T extends object>(row: T, index: number): string {
  const record = row as Record<string, unknown>;
  const candidate = record.id ?? record.key ?? record.uuid ?? record.recordId;
  return candidate === null || candidate === undefined || candidate === "" ? String(index) : String(candidate);
}

function identifierColumn(key: string): boolean {
  return /^(?:id|uuid|key)$/i.test(key) || /(?:Id|Uuid|UUID|ID|Key)$/.test(key) || /(?:^|_)(?:id|uuid|key)$/i.test(key);
}

function dateColumn(key: string): boolean {
  return /(?:On|At|Date)$/.test(key) || /(?:_on|_at|_date)$/.test(key);
}

function moneyColumn(key: string): boolean {
  return key === "cents" || /Cents$/.test(key) || /_cents$/.test(key);
}

function labelColumn(key: string): boolean {
  return /(?:status|state|type|category|readiness|listing|occupancy|frequency|role|relationship|kind|direction|availability|method|source|confidence)$/i.test(key);
}

function knowledgeCellValue(value: unknown): string | undefined {
  if (value === "unknown" || value === "ambiguous" || value === "inferred") return NEEDS_REVIEW;
  if (value === "manual") return "Entered manually";
  if (value === "source" || value === "exact" || value === "confirmed" || value === "known") return "Known";
  return undefined;
}

function defaultCellValue(key: string, value: unknown): ReactNode {
  if (identifierColumn(key)) return NEEDS_REVIEW;
  if (moneyColumn(key)) return formatMoney(value);
  if (dateColumn(key)) return formatDate(value);
  if (value === null || value === undefined || value === "") return NEEDS_REVIEW;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (/knowledge$/i.test(key)) return knowledgeCellValue(value) ?? formatLabel(value);
  if (labelColumn(key)) return formatLabel(value);
  if (Array.isArray(value)) return value.length ? value.map(formatLabel).join(", ") : NEEDS_REVIEW;
  if (typeof value === "object") return NEEDS_REVIEW;
  return String(value);
}

function interactiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, summary, [role='button'], [role='link']"));
}

function widthStyle(width: number | string | undefined): string | number | undefined {
  return typeof width === "number" ? `${width}px` : width;
}

function sortAria(direction: GridSortDirection | undefined): "ascending" | "descending" | "none" {
  if (direction === "asc") return "ascending";
  if (direction === "desc") return "descending";
  return "none";
}

function nextSort(current: GridSortState | undefined, key: string): GridSortState {
  if (!current || current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

function rowFingerprint<T extends object>(
  rows: readonly T[],
  getRowKey: (row: T, index: number) => string,
): string {
  return rows.map((row, index) => getRowKey(row, index)).join("\u001e");
}

/**
 * Compact, keyboard-friendly table for manager records and reports.
 * Filtering, sorting, and paging are all derived from the current row set so
 * a filtered result cannot leave the pager pointing past its final page.
 */
export function DataGrid<T extends Record<string, unknown>>(props: DataGridProps<T>): React.ReactElement;
export function DataGrid<T extends object>(props: DataGridProps<T>): React.ReactElement;
export function DataGrid<T extends object>({
  rows,
  columns,
  getRowKey,
  onRow,
  emptyMessage = "No records match these filters.",
  pageSize = DEFAULT_GRID_PAGE_SIZE,
  search,
  caption,
  initialSort,
  storageKey,
}: DataGridProps<T>) {
  const normalizedStorageKey = preferenceStorageKey(storageKey);
  const normalizedPageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_GRID_PAGE_SIZE;
  const normalizedSearch = search?.trim() ?? "";
  const signature = columnSignature(columns);
  const rowKey = getRowKey ?? defaultRowKey;
  const [sort, setSort] = useState<GridSortState | undefined>(initialSort);
  const [page, setPage] = useState(0);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => readColumnPreferences(normalizedStorageKey, columns));

  useEffect(() => {
    setHiddenColumns(readColumnPreferences(normalizedStorageKey, columns));
  }, [normalizedStorageKey, signature]);

  useEffect(() => {
    writeColumnPreferences(normalizedStorageKey, columns, hiddenColumns);
  }, [normalizedStorageKey, signature, hiddenColumns]);

  const visibleColumns = useMemo(
    () => columns.filter((column) => !hiddenColumns.has(column.key)),
    [columns, hiddenColumns],
  );

  const filteredRows = useMemo(
    () => filterGridRows(rows, normalizedSearch, columns),
    [rows, columns, normalizedSearch],
  );
  const sortedRows = useMemo(
    () => sortGridRows(filteredRows, sort, columns),
    [filteredRows, sort, columns],
  );
  const pageCount = getGridPageCount(sortedRows.length, normalizedPageSize);
  const currentPage = clampGridPage(page, pageCount);
  const pageData = useMemo(
    () => paginateGridRows(sortedRows, currentPage, normalizedPageSize),
    [sortedRows, currentPage, normalizedPageSize],
  );
  const datasetFingerprint = useMemo(() => rowFingerprint(sortedRows, rowKey), [sortedRows, rowKey]);

  // Reset when a search/filter result changes, and clamp if an upstream
  // refresh removes the records on the current page.
  useEffect(() => {
    setPage(0);
  }, [normalizedSearch, datasetFingerprint, normalizedPageSize]);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  function toggleColumn(key: string): void {
    setHiddenColumns((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else if (visibleColumns.length > 1) {
        next.add(key);
      }
      return next;
    });
  }

  function handleSort(key: string): void {
    setSort((current) => nextSort(current, key));
    setPage(0);
  }

  function handleRowClick(event: MouseEvent<HTMLTableRowElement>, row: T): void {
    if (!onRow || interactiveTarget(event.target)) return;
    onRow(row);
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T): void {
    if (!onRow || interactiveTarget(event.target)) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onRow(row);
  }

  const firstShown = pageData.totalRows ? pageData.startIndex + 1 : 0;
  const lastShown = pageData.totalRows ? pageData.endIndex + 1 : 0;
  const visibleCount = visibleColumns.length;

  return (
    <section aria-label={caption}>
      <div className="rm-toolbar">
        <details>
          <summary className="rm-button">Columns <span className="rm-muted">{visibleCount}/{columns.length}</span></summary>
          <div role="group" aria-label="Visible columns">
            {columns.map((column) => {
              const checked = !hiddenColumns.has(column.key);
              return (
                <label key={column.key}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={checked && visibleCount <= 1}
                    onChange={() => toggleColumn(column.key)}
                  />
                  {column.label}
                </label>
              );
            })}
          </div>
        </details>
        {normalizedSearch && <span className="rm-muted" aria-live="polite">{pageData.totalRows} matching {pageData.totalRows === 1 ? "record" : "records"}</span>}
      </div>

      <div className="rm-table-wrap">
        <table className="rm-table">
          {caption && <caption>{caption}</caption>}
          <thead>
            <tr>
              {visibleColumns.map((column) => {
                const active = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={sortAria(active ? sort?.direction : undefined)}
                    style={{ width: widthStyle(column.width), textAlign: column.align }}
                  >
                    <button
                      type="button"
                      className="rm-button"
                      onClick={() => handleSort(column.key)}
                      aria-label={`Sort by ${column.label}${active ? `, currently ${sort?.direction === "asc" ? "ascending" : "descending"}` : ""}`}
                    >
                      <span>{column.label}</span>
                      <span aria-hidden="true">{active ? (sort?.direction === "asc" ? " ↑" : " ↓") : ""}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {!visibleCount || !pageData.totalRows ? (
              <tr>
                <td colSpan={Math.max(1, visibleCount)}><span className="rm-empty">{visibleCount ? emptyMessage : "Choose at least one column to view records."}</span></td>
              </tr>
            ) : pageData.rows.map((row, index) => {
              const absoluteIndex = pageData.startIndex + index;
              const key = rowKey(row, absoluteIndex) || String(absoluteIndex);
              return (
                <tr
                  key={key}
                  tabIndex={onRow ? 0 : undefined}
                  className={onRow ? "clickable" : undefined}
                  aria-label={onRow ? `Open ${caption ?? "record"}` : undefined}
                  onClick={(event) => handleRowClick(event, row)}
                  onKeyDown={(event) => handleRowKeyDown(event, row)}
                >
                  {visibleColumns.map((column) => {
                    const value = (row as Record<string, unknown>)[column.key];
                    return (
                      <td
                        key={column.key}
                        className={column.align === "right" || moneyColumn(column.key) ? "rm-amount" : undefined}
                        style={{ width: widthStyle(column.width), textAlign: column.align }}
                      >
                        {column.render ? column.render(row) : defaultCellValue(column.key, value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageData.totalRows > 0 && (
        <div className="rm-pagination" aria-label="Grid pagination">
          <span className="rm-muted">Showing {firstShown}–{lastShown} of {pageData.totalRows}</span>
          {pageData.pageCount > 1 && (
            <>
              <button type="button" className="rm-button" disabled={currentPage <= 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Previous</button>
              <span aria-live="polite">Page {currentPage + 1} of {pageData.pageCount}</span>
              <button type="button" className="rm-button" disabled={currentPage >= pageData.pageCount - 1} onClick={() => setPage((value) => Math.min(pageData.pageCount - 1, value + 1))}>Next</button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
