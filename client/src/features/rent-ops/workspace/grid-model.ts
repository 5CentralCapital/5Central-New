import type { ReactNode } from "react";

export type GridSortDirection = "asc" | "desc";

export interface GridSortState {
  key: string;
  direction: GridSortDirection;
}

/** Column definition shared by the pure grid model and the React grid. */
export interface GridColumn<T extends object = Record<string, unknown>> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number | null | undefined;
  align?: "left" | "right";
  width?: number | string;
  hidden?: boolean;
}

export const DEFAULT_GRID_PAGE_SIZE = 25;

type SortableColumn<T extends object> = Pick<GridColumn<T>, "key" | "sortValue">;

function rowValue<T extends object>(row: T, column: SortableColumn<T>): unknown {
  return column.sortValue ? column.sortValue(row) : (row as Record<string, unknown>)[column.key];
}

function searchValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(searchValue).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value).map(searchValue).filter(Boolean).join(" ");
  return String(value);
}

/** Return the text used by the optional grid search. */
export function gridSearchText<T extends object>(row: T, columns: readonly SortableColumn<T>[]): string {
  return columns
    .flatMap((column) => {
      const raw = (row as Record<string, unknown>)[column.key];
      const sorted = column.sortValue ? column.sortValue(row) : undefined;
      return [searchValue(raw), searchValue(sorted)];
    })
    .filter(Boolean)
    .join(" ");
}

/** Filter without mutating the source row array. */
export function filterGridRows<T extends object>(
  rows: readonly T[],
  query: string | undefined,
  columns: readonly SortableColumn<T>[],
): T[] {
  const normalizedQuery = query?.trim().toLocaleLowerCase();
  if (!normalizedQuery) return Array.from(rows);
  return rows.filter((row) => gridSearchText(row, columns).toLocaleLowerCase().includes(normalizedQuery));
}

function isUnknownSortValue(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value));
}

function numericString(value: string): bigint | number | undefined {
  const normalized = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return undefined;
  if (/^-?\d+$/.test(normalized)) {
    try {
      return BigInt(normalized);
    } catch {
      return undefined;
    }
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function compareKnownValues(left: unknown, right: unknown): number {
  // API money and count values are numbers.  Relational comparison preserves
  // their numeric ordering without converting them to display strings.
  if (typeof left === "number" && typeof right === "number") {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  // Numeric strings are accepted by the column contract; compare integer
  // strings as BigInts so large exact values keep their ordering.
  if (typeof left === "string" && typeof right === "string") {
    const leftNumeric = numericString(left);
    const rightNumeric = numericString(right);
    if (leftNumeric !== undefined && rightNumeric !== undefined) {
      if (leftNumeric < rightNumeric) return -1;
      if (leftNumeric > rightNumeric) return 1;
      return 0;
    }
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  }

  if (typeof left === "number" && typeof right === "string") {
    const rightNumeric = numericString(right);
    if (rightNumeric !== undefined) {
      if (left < rightNumeric) return -1;
      if (left > rightNumeric) return 1;
      return 0;
    }
  }

  if (typeof left === "string" && typeof right === "number") {
    const leftNumeric = numericString(left);
    if (leftNumeric !== undefined) {
      if (leftNumeric < right) return -1;
      if (leftNumeric > right) return 1;
      return 0;
    }
  }

  const leftText = searchValue(left);
  const rightText = searchValue(right);
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: "base" });
}

/** Stable sort. Unknown values remain at the end in either direction. */
export function sortGridRows<T extends object>(
  rows: readonly T[],
  sort: GridSortState | undefined,
  columns: readonly SortableColumn<T>[],
): T[] {
  if (!sort) return Array.from(rows);
  const column = columns.find((candidate) => candidate.key === sort.key);
  if (!column) return Array.from(rows);

  return rows
    .map((row, index) => ({ row, index, value: rowValue(row, column) }))
    .sort((left, right) => {
      const leftUnknown = isUnknownSortValue(left.value);
      const rightUnknown = isUnknownSortValue(right.value);
      if (leftUnknown || rightUnknown) {
        if (leftUnknown && rightUnknown) return left.index - right.index;
        return leftUnknown ? 1 : -1;
      }

      const comparison = compareKnownValues(left.value, right.value);
      if (comparison !== 0) return sort.direction === "desc" ? -comparison : comparison;
      return left.index - right.index;
    })
    .map(({ row }) => row);
}

export function getGridPageCount(totalRows: number, pageSize: number): number {
  if (!Number.isFinite(totalRows) || totalRows <= 0) return 0;
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_GRID_PAGE_SIZE;
  return Math.ceil(totalRows / safePageSize);
}

export function clampGridPage(page: number, pageCount: number): number {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return 0;
  const safePage = Number.isFinite(page) ? Math.floor(page) : 0;
  return Math.min(Math.max(safePage, 0), pageCount - 1);
}

export interface GridPage<T> {
  rows: T[];
  page: number;
  pageCount: number;
  pageSize: number;
  totalRows: number;
  startIndex: number;
  endIndex: number;
}

/** Slice a zero-based page after filtering and sorting. */
export function paginateGridRows<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): GridPage<T> {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_GRID_PAGE_SIZE;
  const totalRows = rows.length;
  const pageCount = getGridPageCount(totalRows, safePageSize);
  const safePage = clampGridPage(page, pageCount);
  const startIndex = safePage * safePageSize;
  const pageRows = Array.from(rows).slice(startIndex, startIndex + safePageSize);
  return {
    rows: pageRows,
    page: safePage,
    pageCount,
    pageSize: safePageSize,
    totalRows,
    startIndex,
    endIndex: pageRows.length ? startIndex + pageRows.length - 1 : -1,
  };
}

// Short aliases keep the model convenient for non-React report tests while
// leaving the more explicit names above as the public implementation API.
export const filterRows = filterGridRows;
export const sortRows = sortGridRows;
export const paginateRows = paginateGridRows;
