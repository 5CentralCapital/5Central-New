import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { BankingSnapshot } from "../../../../../shared/rent-ops-banking";
import { COLUMNS, SIZES, compact, emptyCells, firstFit, fromPreset, nearestSize, overlaps, parseSavedLayout, phoneLayout, resolve, settle, showCompanyPanelsInAttention, sizeOf, type LayoutItem } from "./dashboard-grid-model";
import { DASHBOARD_PRESETS } from "./dashboard-presets";
import { bankingNetCents, bankingStateNotice, WIDGETS, widgetById, type DashboardData, type WidgetMetrics } from "./dashboard-widgets";

const item = (id: string, x: number, y: number, w: number, h: number): LayoutItem => ({ id, x, y, w, h });

test("every size maps back to its key and fits the grid", () => {
  for (const [key, [w, h]] of Object.entries(SIZES)) { assert.equal(sizeOf(w, h), key); assert.ok(w <= COLUMNS); }
});

test("resolve pushes overlapped widgets down and compact floats them back up", () => {
  const layout = [item("a", 0, 0, 4, 2), item("b", 0, 2, 4, 2), item("c", 4, 0, 4, 4)];
  const moved = layout[0];
  moved.y = 1;
  resolve(moved, layout);
  assert.equal(layout[1].y, 3, "b moves under a");
  compact(layout, moved);
  assert.equal(layout[1].y, 3);
  moved.y = 0;
  compact(layout);
  assert.equal(layout[1].y, 2, "b floats back up when the space frees");
  assert.deepEqual(overlaps(layout), []);
});

test("firstFit scans reading order and settle removes overlaps without moving x", () => {
  const layout = [item("a", 0, 0, 8, 2), item("b", 8, 0, 4, 4)];
  assert.deepEqual(firstFit(4, 2, layout), { x: 0, y: 2 });
  assert.deepEqual(firstFit(2, 2, layout), { x: 0, y: 2 });
  const clashing = [item("a", 0, 0, 4, 3), item("b", 0, 1, 4, 2), item("c", 2, 0, 4, 2)];
  settle(clashing);
  assert.deepEqual(overlaps(clashing), []);
  assert.deepEqual(clashing.map(entry => entry.x), [0, 0, 2]);
});

test("nearestSize snaps a dragged rectangle to an allowed size", () => {
  assert.equal(nearestSize(["S", "M", "MT", "L"], 3.6, 2.2), "M");
  assert.equal(nearestSize(["S", "M", "MT", "L"], 4.1, 3.4), "MT");
  assert.equal(nearestSize(["MT", "L"], 1, 1), "MT");
  assert.equal(nearestSize(["XT", "XL"], 12, 6), "XL");
});

test("presets tile the grid with no overlaps or holes and only known widgets", () => {
  for (const [name, entries] of Object.entries(DASHBOARD_PRESETS)) {
    if (!entries) continue;
    for (const entry of entries) assert.ok(widgetById(entry.id), `${name}: ${entry.id} exists`);
    for (const entry of entries) assert.ok(widgetById(entry.id)!.sizes.includes(entry.size), `${name}: ${entry.id} allows ${entry.size}`);
    const layout = fromPreset(entries, id => !!widgetById(id));
    assert.deepEqual(overlaps(layout), [], `${name} has no overlaps`);
    assert.equal(emptyCells(layout), 0, `${name} has no empty cells`);
  }
});

test("every widget's default size is one of its sizes", () => {
  for (const widget of WIDGETS) assert.ok(widget.sizes.includes(widget.defaultSize), widget.id);
  assert.equal(new Set(WIDGETS.map(widget => widget.id)).size, WIDGETS.length, "ids are unique");
});

test("phone layout keeps reading order in four columns", () => {
  const layout = fromPreset(DASHBOARD_PRESETS.Command!, id => !!widgetById(id));
  const phone = phoneLayout(layout);
  assert.deepEqual(overlaps(phone), []);
  assert.ok(phone.every(entry => entry.x + entry.w <= 4));
  assert.equal(phone[0].id, layout[0].id);
});

test("saved layouts are validated and repaired", () => {
  assert.equal(parseSavedLayout(null, () => true), undefined);
  assert.equal(parseSavedLayout("{}", () => true), undefined);
  const saved = parseSavedLayout(JSON.stringify({ version: 1, preset: "Custom", layout: [item("kpi-due", 0, 0, 2, 2), item("kpi-due-gone", 0, 0, 2, 2), item("cash", 0, 0, 4, 2), { id: "bad", x: 11, y: 0, w: 4, h: 2 }] }), id => id === "kpi-due" || id === "cash");
  assert.ok(saved);
  assert.deepEqual(saved!.layout.map(entry => entry.id), ["kpi-due", "cash"]);
  assert.deepEqual(overlaps(saved!.layout), []);
});

test("banking totals stay unknown until the complete read is ready", () => {
  const partial = {
    state: "partial", fetchedAt: "2026-09-24T12:00:00.000Z", fromDate: "2026-08-26", throughDate: "2026-09-24",
    connections: [{ id: "connection", name: "Operating", balancesState: "ready", transactionsLastSuccessfulUpdate: null, transactionsLastFailedUpdate: null, accounts: [], transactions: [{ id: "deposit", accountId: "account", date: "2026-09-20", description: "Deposit", amountCents: -5000, currency: "USD", pending: false }] }],
  } as BankingSnapshot;
  assert.equal(bankingNetCents(partial), undefined);
  assert.equal(bankingStateNotice(partial.state, "Money in and out")?.title, "Money in and out incomplete");
  assert.equal(bankingNetCents({ ...partial, state: "ready" }), 5000);
});

test("banking widgets expose incomplete reads instead of exact or zero totals", () => {
  const partial = {
    state: "partial", fetchedAt: "2026-09-24T12:00:00.000Z", fromDate: "2026-08-26", throughDate: "2026-09-24", connections: [],
  } as BankingSnapshot;
  const metrics: WidgetMetrics = { size: "M", w: 4, h: 2, bodyWidth: 100, bodyHeight: 100 };
  const data = { banking: { data: partial, loading: false, refetch: () => {} } } as DashboardData;
  const moneyMarkup = renderToStaticMarkup(widgetById("money-in-out")!.render({ data, metrics }));
  const activityMarkup = renderToStaticMarkup(widgetById("bank-activity")!.render({ data, metrics }));
  assert.match(moneyMarkup, /Money in and out incomplete/);
  assert.doesNotMatch(moneyMarkup, /Net|\$0/);
  assert.match(activityMarkup, /Bank activity incomplete/);
  assert.doesNotMatch(activityMarkup, /No transactions/);
});

test("cash widget exposes a failed request with a retry action", () => {
  const metrics: WidgetMetrics = { size: "M", w: 4, h: 2, bodyWidth: 100, bodyHeight: 100 };
  const data = { cash: { error: "request failed", fetching: false, refetch: () => {} } } as DashboardData;
  const markup = renderToStaticMarkup(widgetById("cash")!.render({ data, metrics }));
  assert.match(markup, /Cash balance unavailable/);
  assert.match(markup, />Retry</);
});

test("company panels stay in attention only without a company widget", () => {
  assert.equal(showCompanyPanelsInAttention([item("attention", 0, 0, 8, 3)]), true);
  assert.equal(showCompanyPanelsInAttention([item("attention", 0, 0, 8, 3), item("company", 0, 3, 4, 3)]), false);
});
