import assert from "node:assert/strict";
import test from "node:test";
import { formatDate, formatLabel, formatMoney } from "./display";
import { filterGridRows, paginateGridRows, sortGridRows, type GridColumn } from "./grid-model";

type Row = Record<string, unknown> & { name: string; cents?: number | null; position: number };

const columns: GridColumn<Row>[] = [
  { key: "name", label: "Name" },
  { key: "cents", label: "Amount", sortValue: (row) => row.cents },
];

test("money display preserves zero and marks unknown cents", () => {
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(125050), "$1,250.50");
  assert.equal(formatMoney(null), "Needs review");
  assert.equal(formatMoney(""), "Needs review");
  assert.equal(formatMoney(10.5), "Needs review");
});

test("date and label display values are readable and deterministic", () => {
  assert.equal(formatDate("2026-01-05"), "Jan 5, 2026");
  assert.equal(formatDate(undefined), "Needs review");
  assert.equal(formatLabel("future_preleased"), "Future Preleased");
  assert.equal(formatLabel("monthToMonth"), "Month To Month");
});

test("grid sorting is numeric, stable, and leaves unknown values last", () => {
  const rows: Row[] = [
    { name: "ten", cents: 10, position: 0 },
    { name: "two", cents: 2, position: 1 },
    { name: "unknown", cents: null, position: 2 },
    { name: "two again", cents: 2, position: 3 },
  ];
  assert.deepEqual(sortGridRows(rows, { key: "cents", direction: "asc" }, columns).map((row) => row.name), ["two", "two again", "ten", "unknown"]);
  assert.deepEqual(sortGridRows(rows, { key: "cents", direction: "desc" }, columns).map((row) => row.name), ["ten", "two", "two again", "unknown"]);
});

test("search and paging do not mutate rows and clamp out of bounds pages", () => {
  const rows: Row[] = Array.from({ length: 51 }, (_, position) => ({ name: `Unit ${position + 1}`, position, cents: position }));
  const matching = filterGridRows(rows, "unit 5", columns);
  assert.deepEqual(matching.map((row) => row.name), ["Unit 5", "Unit 50", "Unit 51"]);
  const page = paginateGridRows(rows, 99, 25);
  assert.equal(page.page, 2);
  assert.equal(page.pageCount, 3);
  assert.equal(page.rows.length, 1);
  assert.equal(rows[0].name, "Unit 1");
});
