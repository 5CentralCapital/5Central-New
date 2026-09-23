import assert from "node:assert/strict";
import test from "node:test";
import { createAuthenticatedPrincipal } from "../company/authorization";
import { formatReportTotal } from "../../shared/reporting/format";
import { createReportingRegistry } from "./registry";
import { InMemoryReportingStore } from "./store";
import { ReportingService } from "./service";
import { csvCell, exportReportCsv, neutralizeCsvFormula } from "./export";

const organizationId = "11111111-1111-4111-8111-111111111111";
const principal = createAuthenticatedPrincipal({ actorId: "export-actor", organizationId, role: "admin", authorizedScopes: [{}] });
const scope = { organizationId, legalEntityIds: [], propertyIds: [], unitIds: [], tenantIds: [], tenancyIds: [], ownerIds: [], investorIds: [], projectIds: [], vendorIds: [], staffIds: [] };

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\r" && text[index + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; index += 1; }
    else cell += character;
  }
  return rows;
}

async function exportedRun() {
  const registry = createReportingRegistry({ engines: [{
    key: "test.export", reportIds: ["work-orders"], ready: true,
    async run() {
      return {
        columns: [
          { id: "title", label: "Work order", type: "text", sortable: true, filterable: true, sensitive: false },
          { id: "status", label: "Status", type: "status", sortable: true, filterable: true, sensitive: false },
          { id: "estimatedCostCents", label: "Estimated cost", type: "money", sortable: true, filterable: true, sensitive: false },
        ],
        rows: [
          { rowId: "row-1", values: { title: "=HYPERLINK(\"http://example.test\")", status: "new", estimatedCostCents: "123456", currency: "USD" } },
          { rowId: "row-2", values: { title: "+SUM(A1:A2)", status: "on_hold", estimatedCostCents: "-2500", currency: "USD" } },
          { rowId: "row-3", values: { title: "@cmd", status: "scheduled", estimatedCostCents: "7", currency: "USD" } },
          { rowId: "row-4", values: { title: "-10 degrees\tthen", status: "completed", estimatedCostCents: null, currency: "USD" } },
          { rowId: "row-5", values: { title: "<script>alert(1)</script>, \"quoted\"", status: "canceled", estimatedCostCents: "0", currency: "USD" } },
        ],
        totals: [{ key: "estimated_cost", amountCents: "120963", currency: "USD", state: "partial" }],
        coverage: [{ source: "company_work_orders", state: "partial", evidence: "synthetic", basis: "operational", watermark: null, observedAt: "2026-09-21T00:00:00.000Z", coveredFrom: null, coveredThrough: null, rowCount: 5, reason: "One order has no estimate." }],
        missingData: [{ code: "work_order_estimate_missing", state: "partial", message: "1 work order has no estimated cost." }],
      };
    },
  }] });
  const service = new ReportingService({ registry, store: new InMemoryReportingStore(), now: () => new Date("2026-09-21T00:00:00.000Z") });
  const result = await service.run({ principal }, { reportId: "work-orders", definitionVersion: "1", scope, filters: {}, period: { mode: "custom", asOfDate: "2026-09-21" }, basis: "operational", currency: null });
  return { service, result };
}

test("CSV exports neutralize formula injection and keep money numeric and exact", async () => {
  assert.equal(neutralizeCsvFormula("=1+1"), "'=1+1");
  for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) assert.ok(neutralizeCsvFormula(`${prefix}x`).startsWith("'"), JSON.stringify(prefix));
  assert.equal(neutralizeCsvFormula("Plain"), "Plain");
  assert.equal(csvCell("-12.34", { numeric: true }), "-12.34");
  assert.equal(csvCell("-12.34"), "'-12.34");
  const { service, result } = await exportedRun();
  const job = await service.createExport({ principal }, { runId: result.run.id, format: "csv" });
  const rows = parseCsv(job.content!);
  assert.deepEqual(rows[0], ["Row", "Work order", "Status", "Estimated cost (amount)"]);
  const titles = rows.slice(1, 6).map(row => row[1]);
  assert.deepEqual(titles, ["'=HYPERLINK(\"http://example.test\")", "'+SUM(A1:A2)", "'@cmd", "'-10 degrees\tthen", "<script>alert(1)</script>, \"quoted\""]);
  assert.deepEqual(rows.slice(1, 6).map(row => row[3]), ["1234.56", "-25.00", "0.07", "", "0.00"]);
  for (const row of rows.slice(1)) for (const cell of row) if (!/^-?\d+\.\d{2}$/.test(cell)) assert.ok(!/^[=+\-@\t\r]/.test(cell), `unsafe cell ${JSON.stringify(cell)}`);
});

test("export totals match the API run totals and the on-screen formatter", async () => {
  const { service, result } = await exportedRun();
  const csv = parseCsv((await service.createExport({ principal }, { runId: result.run.id, format: "csv" })).content!);
  const totalsHeader = csv.findIndex(row => row[0] === "Total");
  assert.ok(totalsHeader > 0);
  assert.deepEqual(csv[totalsHeader + 1], ["Estimated cost", "1209.63", "USD", "partial"]);
  // The export total is the service total, and it equals the exact row sum.
  const rowSum = csv.slice(1, 6).reduce((sum, row) => sum + (row[3] ? BigInt(row[3].replace(".", "")) : BigInt(0)), BigInt(0));
  assert.equal(rowSum.toString(), result.run.totals[0]!.amountCents);
  const json = JSON.parse((await service.createExport({ principal }, { runId: result.run.id, format: "json" })).content!);
  assert.deepEqual(json.totals, result.page.totals);
  assert.equal(json.rows.length, result.page.totalRows);
  const html = (await service.createExport({ principal }, { runId: result.run.id, format: "html" })).content!;
  assert.ok(html.includes(formatReportTotal(result.page.totals[0]!)), "HTML shows the same formatted total as the screen");
  assert.ok(html.includes("$1,234.56") && html.includes("−$25.00"));
  assert.ok(!html.includes("<script>alert"), "cell text is escaped");
  assert.ok(html.includes("One order has no estimate.") && html.includes("1 work order has no estimated cost."));
  assert.ok(html.includes("@media print"));
  assert.ok(html.includes("<title>Work orders</title>"));
  assert.equal(exportReportCsv({ ...result.run, totals: [] }).includes("Total,Amount"), false);
});
