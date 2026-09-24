import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, webkit, expect as playwrightExpect, type Download, type Locator, type Page } from '@playwright/test';
import { createCompanyDemoApp } from '../../server/company/demo';

const expect = playwrightExpect.configure({ timeout: 15_000 });

/**
 * Synthetic browser acceptance for the report setup boundary.
 *
 * This intentionally treats a report request as a user action. The report
 * workspace may still read its directory, catalog, dashboard preview, or
 * workspace bootstrap while this test is running; only `/reports/:report`
 * and `/reports/:report/csv` are included in `reportRequests`.
 */

const output = resolve(process.env.ROPS_EVIDENCE_DIR ?? '/Users/michaelmcelwee/Projects/r-ops-build-evidence/2026-09-21/report-setup');
await mkdir(output, { recursive: true });

const demo = await createCompanyDemoApp();
const listener = demo.app.listen(0, '127.0.0.1');
await new Promise<void>((done) => listener.once('listening', done));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

type ReportMode = 'as-of' | 'month' | 'range';
type ReportCase = { key: string; label: string; mode: ReportMode; autoRun?: boolean };
type ReportRequest = {
  method: string;
  url: string;
  report: string;
  kind: 'run' | 'csv';
  query: Record<string, string>;
};

type PageDiagnostics = {
  reportRequests: ReportRequest[];
  pageErrors: string[];
  requestFailures: string[];
  consoleErrors: string[];
};

const pageDiagnostics = new WeakMap<Page, PageDiagnostics>();

const reports: ReportCase[] = [
  { key: 'rent-roll', label: 'Rent roll', mode: 'as-of', autoRun: true },
  { key: 'occupancy', label: 'Vacancies', mode: 'as-of', autoRun: true },
  { key: 'scheduled-income', label: 'Scheduled income', mode: 'month' },
  { key: 'collected-income', label: 'Collected income', mode: 'range' },
  { key: 'scheduled-vs-collected', label: 'Scheduled vs collected', mode: 'month' },
  { key: 'delinquency', label: 'Balances due', mode: 'as-of', autoRun: true },
  { key: 'tenant-ledger', label: 'Tenant statement', mode: 'range' },
  { key: 'lease-expiration', label: 'Lease expirations', mode: 'as-of' },
  { key: 'security-deposit', label: 'Security deposit and liabilities', mode: 'as-of' },
  { key: 'applicant-pipeline', label: 'Applicant pipeline', mode: 'as-of' },
  { key: 'hap', label: 'Housing assistance', mode: 'month' },
];

const expected = {
  asOfDate: '2026-08-15',
  month: '2026-08',
  fromDate: '2026-08-01',
  toDate: '2026-08-15',
  propertyId: 'demo-property-a',
  secondPropertyId: 'demo-property-b',
  unitId: 'demo-unit-a-1',
  secondUnitId: 'demo-unit-b-1',
  personId: 'demo-person-1',
  status: 'current',
};

const results: Array<Record<string, unknown>> = [];

function reportRequestFromUrl(requestUrl: string, method: string): ReportRequest | undefined {
  const parsed = new URL(requestUrl);
  const match = parsed.pathname.match(/\/api\/rent-ops\/reports\/([^/]+)(\/csv)?$/);
  if (!match) return undefined;
  const report = decodeURIComponent(match[1]);
  const kind = match[2] ? 'csv' : 'run';
  return {
    method,
    url: requestUrl,
    report,
    kind,
    query: Object.fromEntries(parsed.searchParams.entries()),
  };
}

function attachReportRequestLog(page: Page): ReportRequest[] {
  const requests: ReportRequest[] = [];
  const diagnostics: PageDiagnostics = { reportRequests: requests, pageErrors: [], requestFailures: [], consoleErrors: [] };
  pageDiagnostics.set(page, diagnostics);
  page.on('request', (request) => {
    const reportRequest = reportRequestFromUrl(request.url(), request.method());
    if (reportRequest) requests.push(reportRequest);
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('requestfailed', (request) => diagnostics.requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown'}`));
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  return requests;
}

function setupRoot(page: Page): Locator {
  return page.locator('[data-report-setup], .rm-report-setup').first();
}

function resultsRoot(page: Page): Locator {
  return page.locator('[data-report-results], .rm-report-results, .rm-report-result').first();
}

function filterControl(setup: Locator, key: string, labels: string[]): Locator {
  void labels;
  return setup.locator(`[name="${key}"]`).first();
}

function periodControl(setup: Locator, key: string, labels: string[], type: string): Locator {
  void labels;
  void type;
  return setup.locator(`[name="${key}"]`).first();
}

async function firstVisible(locator: Locator): Promise<Locator> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  return locator.first();
}

async function selectFilter(setup: Locator, key: string, value: string, labels: string[]): Promise<void> {
  const control = await firstVisible(filterControl(setup, key, labels));
  await expect(control).toBeVisible();
  const tag = await control.evaluate((element) => element.tagName.toLowerCase());
  if (tag === 'select') {
    await control.selectOption(value);
    return;
  }
  await control.click();
  const option = setup.getByRole('option', { name: new RegExp(value, 'i') }).first();
  if (await option.count()) await option.click();
}

async function selectProperty(setup: Locator, propertyId: string): Promise<void> {
  const field = setup.locator('[data-report-filter="propertyIds"]').first();
  if (await field.count()) {
    const tag = await field.evaluate((element) => element.tagName.toLowerCase());
    if (tag === 'select') {
      await field.selectOption(propertyId);
      return;
    }
    const nestedSelect = field.locator('select, input').first();
    if (await nestedSelect.count()) {
      const nestedTag = await nestedSelect.evaluate((element) => element.tagName.toLowerCase());
      if (nestedTag === 'select') {
        await nestedSelect.selectOption(propertyId);
        return;
      }
    }
  }
  // The current picker is intentionally a compact disclosure rather than a
  // native select. Keep this fallback so the test also documents its keyboard
  // and accessible checkbox contract while the UI adds stable data hooks.
  await expect(field).toBeVisible();
  const details = field.locator('details').first();
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
  const targetName = propertyId === expected.propertyId ? 'Demo Harbor Homes' : propertyId === expected.secondPropertyId ? 'Demo Grove Flats' : propertyId;
  const target = details.getByRole('checkbox', { name: new RegExp(targetName, 'i') });
  // A property change is a replacement in this smoke: leaving the previous
  // property selected would make a dependent unit remain valid by design.
  for (const name of ['Demo Harbor Homes', 'Demo Grove Flats']) {
    const checkbox = details.getByRole('checkbox', { name: new RegExp(name, 'i') });
    if (await checkbox.count() && await checkbox.isChecked() && !new RegExp(name, 'i').test(targetName)) await checkbox.uncheck();
  }
  if (!(await target.isChecked())) await target.check();
}

async function fillPeriod(setup: Locator, report: ReportCase, values = expected): Promise<void> {
  if (report.mode === 'as-of') {
    const input = await firstVisible(periodControl(setup, 'asOfDate', ['As of', 'As of date', 'Report date'], 'date'));
    await input.fill(values.asOfDate);
    return;
  }
  if (report.mode === 'month') {
    const input = await firstVisible(periodControl(setup, 'month', ['Month', 'Report month'], 'month'));
    await input.fill(values.month);
    const asOf = setup.getByLabel(/As of|As of date|Report date/i).first();
    if (await asOf.count() && await asOf.isVisible()) await asOf.fill(values.asOfDate);
    return;
  }
  const from = await firstVisible(periodControl(setup, 'fromDate', ['From', 'From date', 'Start date', 'Activity from'], 'date'));
  const through = await firstVisible(periodControl(setup, 'toDate', ['Through', 'Through date', 'End date', 'Activity through'], 'date'));
  await from.fill(values.fromDate);
  await through.fill(values.toDate);
}

async function assertPeriodControls(page: Page, report: ReportCase): Promise<void> {
  let setup = setupRoot(page);
  await expect(setup).toHaveCount(1);
  if (report.mode === 'as-of') {
    await expect(await firstVisible(periodControl(setup, 'asOfDate', ['As of', 'As of date', 'Report date'], 'date'))).toBeVisible();
    await expect(setup.locator('input[type="month"]')).toHaveCount(0);
    return;
  }
  if (report.mode === 'month') {
    await expect(await firstVisible(periodControl(setup, 'month', ['Month', 'Report month'], 'month'))).toBeVisible();
    return;
  }
  await expect(await firstVisible(periodControl(setup, 'fromDate', ['From', 'From date', 'Start date', 'Activity from'], 'date'))).toBeVisible();
  await expect(await firstVisible(periodControl(setup, 'toDate', ['Through', 'Through date', 'End date', 'Activity through'], 'date'))).toBeVisible();
}

/**
 * The rental reports (rent roll, vacancies, balances due) open on their
 * results with the setup summarized as chips; the full form is behind the
 * "Filter" toggle. Other reports open with the form expanded.
 */
async function ensureSetupOpen(page: Page): Promise<void> {
  const toggle = page.locator('.rm-report-filter-toggle').first();
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(setupRoot(page)).toHaveCount(1);
}

async function openReport(page: Page, report: ReportCase): Promise<void> {
  await page.goto(`${origin}/ops?section=reports&report=${encodeURIComponent(report.key)}&scope=all&asOf=${expected.asOfDate}&status=all&search=`);
  await ensureSetupOpen(page);
  const heading = page.getByRole('heading', { name: new RegExp(report.label, 'i') }).first();
  if (await heading.count()) await expect(heading).toBeVisible();
  await assertPeriodControls(page, report);
}

async function waitForReportResults(page: Page): Promise<void> {
  await expect(resultsRoot(page)).toBeVisible();
  await expect(resultsRoot(page).locator('table, [data-report-row], [role="row"]').first()).toBeVisible();
}

function runReportButton(page: Page): Locator {
  return page.getByRole('button', { name: /Run report|Update report/i }).first();
}

function assertQuery(request: ReportRequest, expectedQuery: Record<string, string>): void {
  expect(request.kind).toBe('run');
  for (const [key, value] of Object.entries(expectedQuery)) expect(request.query[key], `${request.report} query ${key}`).toBe(value);
}

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
}

async function assertReportLayoutContained(page: Page, label: string): Promise<void> {
  const violations = await page.evaluate(() => {
    const selectors = [
      '[data-report-setup]',
      '[data-report-setup] [data-report-filter]',
      '[data-report-setup] .rm-report-setup-run',
      '[data-report-results] .rm-report-results-toolbar',
      '[data-report-results] .rm-report-results-toolbar button',
    ];
    return selectors.flatMap(selector => Array.from(document.querySelectorAll<HTMLElement>(selector)).map(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { selector, text: element.textContent?.trim().slice(0, 80) ?? '', visible: style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0, left: rect.left, right: rect.right, width: rect.width };
    })).filter(item => item.visible && (item.left < -1 || item.right > window.innerWidth + 1));
  });
  expect(violations, `${label} report controls stay within the viewport`).toEqual([]);
}

async function settleScreenshot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    document.querySelectorAll('.rops-skip-link, a[href="#main-content"], [data-skip-link]').forEach((element) => {
      if (element instanceof HTMLElement) element.blur();
    });
  });
  // The workspace restores a route's saved scroll position on the next frame,
  // which can land after a single scrollTo. Re-issue it until it holds.
  await expect.poll(() => page.evaluate(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); return new Promise<number>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(window.scrollY)))); }), { timeout: 5_000 }).toBe(0);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function mobileSelectHeights(page: Page, setup: Locator): Promise<Array<Record<string, unknown>>> {
  return setup.locator('select').evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      name: element.getAttribute('name'),
      height: rect.height,
      width: rect.width,
      minHeight: style.minHeight,
      appearance: style.appearance,
    };
  }));
}

async function downloadedText(download: Download): Promise<string> {
  const path = await download.path();
  if (!path) throw new Error('CSV download path was unavailable');
  return readFile(path, 'utf8');
}

async function clickExportCsv(page: Page): Promise<{ download: Download; text: string }> {
  const exportButton = page.getByRole('button', { name: /Export CSV|CSV/i }).first();
  await expect(exportButton).toBeEnabled();
  const downloadPromise = page.waitForEvent('download', { timeout: 2000 }).catch(() => undefined);
  await exportButton.click();
  // Implementations with a confirmation sheet still use the same applied run.
  let download = await downloadPromise;
  if (!download) {
    const submit = page.getByRole('button', { name: /Download CSV|Export CSV/i }).last();
    await submit.waitFor({ state: 'visible', timeout: 3000 });
    const submittedDownload = page.waitForEvent('download');
    await submit.click();
    download = await submittedDownload;
  }
  return { download, text: await downloadedText(download) };
}

async function runDesktop(page: Page, browserName: string): Promise<Record<string, unknown>> {
  const started = performance.now();
  const reportRequests = attachReportRequestLog(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => void dialog.accept());

  // Dashboard navigation can fetch preview reports. The request log is scoped
  // to `/reports/:report`, so those existing dashboard paths remain harmless.
  await page.goto(`${origin}/ops?section=dashboard&scope=all&asOf=${expected.asOfDate}`);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.locator('.rmd-top-grid > section')).toHaveCount(6);
  await expect(page.locator('.rmd-trend-grid > section')).toHaveCount(3);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  const baselineAfterDashboard = reportRequests.length;

  // A fresh page keeps late dashboard preview requests from obscuring the
  // direct-route assertion. The report-specific log must remain empty until
  // the user presses Run.
  const direct = reports[0];
  const browser = page.context().browser();
  if (!browser) throw new Error('Direct-route smoke could not access its browser context');
  const directContext = await browser.newContext({ viewport: page.viewportSize() ?? { width: 1440, height: 1000 } });
  const directPage = await directContext.newPage();
  const directRequests = attachReportRequestLog(directPage);
  const directPageErrors: string[] = [];
  directPage.on('pageerror', (error) => directPageErrors.push(error.message));
  try {
    await openReport(directPage, direct);
    // Rent roll runs on open with its default setup and shows results at once.
    await expect.poll(() => directRequests.length, { message: 'direct rent roll route runs on open' }).toBeGreaterThan(0);
    await waitForReportResults(directPage);
    await expect(directPage.locator('.rm-report-active-setup .ops-chip').first()).toBeVisible();
    await expect(runReportButton(directPage)).toHaveCount(0);
    pageErrors.push(...directPageErrors);
  } finally {
    await directContext.close();
  }

  // Navigation → library → report must keep the same no-auto-run guarantee.
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.getByRole('button', { name: 'Reporting', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Report library', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report library', exact: true })).toBeVisible();
  const library = page.getByRole('region', { name: 'Report library', exact: true });
  await library.getByRole('combobox', { name: 'Show reports' }).selectOption('available');
  // Runtime availability: the 11 rental reports plus every company report whose engine can run for this company.
  await expect(library.locator('[data-report-id="rent-roll"]')).toHaveCount(1);
  expect(await library.locator('[data-report-id]').count(), 'available reports include at least the 11 rental reports').toBeGreaterThanOrEqual(11);
  await library.locator('[data-report-id="rent-roll"] .rops-report-open').click();
  await expect.poll(() => reportRequests.length, { message: 'library rent roll open runs the report' }).toBeGreaterThan(baselineAfterDashboard);
  await waitForReportResults(page);

  // Every available report has its own setup mode. The rental reports run
  // on open; every other report starts with no report request, even when it
  // has a previously cached query in React Query.
  const reportSetupEvidence: Array<Record<string, unknown>> = [];
  for (const report of reports) {
    const before = reportRequests.length;
    await openReport(page, report);
    await assertPeriodControls(page, report);
    if (report.autoRun) {
      await expect.poll(() => reportRequests.length, { message: `${report.key} runs on open` }).toBeGreaterThan(before);
      await waitForReportResults(page);
    } else {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
      expect(reportRequests.length, `${report.key} opens without a report request`).toBe(before);
    }
    reportSetupEvidence.push({ key: report.key, label: report.label, mode: report.mode, autoRun: Boolean(report.autoRun), requestCountBeforeRun: before });
  }

  // Pick a report with every scope/status field. The exact query is the
  // contract: no ignored UI values may be silently dropped at Run time.
  const selected = reports.find((report) => report.key === 'tenant-ledger')!;
  await openReport(page, selected);
  let setup = setupRoot(page);
  await selectProperty(setup, expected.propertyId);
  await selectFilter(setup, 'unitId', expected.unitId, ['Unit']);
  await selectFilter(setup, 'personId', expected.personId, ['Tenant', 'Person', 'Resident']);
  await selectFilter(setup, 'tenantStatus', expected.status, ['Tenant status', 'Status']);
  await fillPeriod(setup, selected);
  const beforeRun = reportRequests.length;
  await runReportButton(page).click();
  await expect.poll(() => reportRequests.length).toBeGreaterThan(beforeRun);
  await waitForReportResults(page);
  const run = reportRequests.at(-1)!;
  assertQuery(run, {
    propertyIds: expected.propertyId,
    unitId: expected.unitId,
    personId: expected.personId,
    tenantStatus: expected.status,
    asOfDate: expected.asOfDate,
    fromDate: expected.fromDate,
    toDate: expected.toDate,
  });
  const configuredRunUrl = run.url;
  let resultTextBeforeChange = await resultsRoot(page).innerText();
  expect(resultTextBeforeChange.length).toBeGreaterThan(0);
  expect(resultTextBeforeChange).toMatch(/Demo Harbor Homes|1A|Tenant One/i);
  expect(resultTextBeforeChange).toMatch(/opening balance/i);
  const exportButton = page.getByRole('button', { name: /Export CSV|CSV/i }).first();
  await expect(exportButton).toBeEnabled();

  // Re-submitting the same setup is an explicit refresh and must issue a new
  // request. A harmless result sort then verifies a parent render preserves
  // the just-run rows instead of resetting the applied state.
  const beforeRepeatRun = reportRequests.length;
  await runReportButton(page).click();
  await expect.poll(() => reportRequests.length).toBeGreaterThan(beforeRepeatRun);
  expect(reportRequests.at(-1)?.url).toBe(configuredRunUrl);
  const resultSort = resultsRoot(page).locator('thead button').first();
  if (await resultSort.count()) await resultSort.click();
  await expect(resultsRoot(page)).toBeVisible();

  // Keep the same SPA and query cache alive while reopening through the
  // navigation library. The applied rows are cached, but opening the report
  // still must not implicitly issue another report request.
  const afterFirstRun = reportRequests.length;
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Reporting', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Report library', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Report library', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Report library', exact: true }).locator('[data-report-id="tenant-ledger"] .rops-report-open').click();
  await expect(setupRoot(page)).toHaveCount(1);
  expect(reportRequests.length, 'cached library reopen does not auto-run').toBe(afterFirstRun);
  setup = setupRoot(page);

  // A cached reopen still requires an explicit first Run. Reapply the same
  // filters so this assertion remains independent of preference restoration.
  await selectProperty(setup, expected.propertyId);
  await selectFilter(setup, 'unitId', expected.unitId, ['Unit']);
  await selectFilter(setup, 'personId', expected.personId, ['Tenant', 'Person', 'Resident']);
  await selectFilter(setup, 'tenantStatus', expected.status, ['Tenant status', 'Status']);
  await fillPeriod(setup, selected);
  const beforeCachedRun = reportRequests.length;
  await runReportButton(page).click();
  await expect.poll(() => reportRequests.length).toBeGreaterThan(beforeCachedRun);
  await waitForReportResults(page);
  const cachedRun = reportRequests.at(-1)!;
  assertQuery(cachedRun, {
    propertyIds: expected.propertyId,
    unitId: expected.unitId,
    personId: expected.personId,
    tenantStatus: expected.status,
    asOfDate: expected.asOfDate,
    fromDate: expected.fromDate,
    toDate: expected.toDate,
  });
  resultTextBeforeChange = await resultsRoot(page).innerText();
  expect(resultTextBeforeChange).toMatch(/opening balance/i);
  await expect(exportButton).toBeEnabled();

  // Any setup change invalidates the displayed run and locks export until the
  // new setup is explicitly run.
  await selectProperty(setup, expected.secondPropertyId);
  await expect.poll(async () => {
    if (await exportButton.count() === 0) return true;
    return await exportButton.isDisabled();
  }).toBe(true);
  await expect.poll(async () => {
    const root = resultsRoot(page);
    if (!(await root.count()) || !(await root.isVisible())) return true;
    return (await root.innerText()) !== resultTextBeforeChange;
  }).toBe(true);
  const beforeChangedRun = reportRequests.length;
  await runReportButton(page).click();
  await expect.poll(() => reportRequests.length).toBeGreaterThan(beforeChangedRun);
  await waitForReportResults(page);
  const changedRun = reportRequests.at(-1)!;
  expect(changedRun.url).not.toBe(configuredRunUrl);
  expect(changedRun.query.propertyIds).toBe(expected.secondPropertyId);
  await expect(exportButton).toBeEnabled();
  await expect(resultsRoot(page)).toContainText(/Demo Grove Flats|1B/i);

  // Invalid periods render an actionable error and never hit the report API.
  await openReport(page, { key: 'collected-income', label: 'Collected income', mode: 'range' });
  const rangeSetup = setupRoot(page);
  const from = await firstVisible(periodControl(rangeSetup, 'fromDate', ['From', 'From date', 'Start date', 'Activity from'], 'date'));
  const through = await firstVisible(periodControl(rangeSetup, 'toDate', ['Through', 'Through date', 'End date', 'Activity through'], 'date'));
  await from.fill('2026-08-20');
  await through.fill('2026-08-10');
  const beforeInvalidRun = reportRequests.length;
  await expect(page.getByRole('alert')).toContainText(/start|before|range|valid/i);
  await expect(runReportButton(page)).toBeDisabled();
  expect(reportRequests.length).toBe(beforeInvalidRun);

  // Changing property clears dependent unit/person selections, avoiding a
  // request containing IDs that no longer belong to the selected property.
  await openReport(page, selected);
  const dependencySetup = setupRoot(page);
  await selectProperty(dependencySetup, expected.propertyId);
  await selectFilter(dependencySetup, 'unitId', expected.unitId, ['Unit']);
  await selectFilter(dependencySetup, 'personId', expected.personId, ['Tenant', 'Person', 'Resident']);
  await selectProperty(dependencySetup, expected.secondPropertyId);
  const unitAfterProperty = await firstVisible(filterControl(dependencySetup, 'unitId', ['Unit']));
  const personAfterProperty = await firstVisible(filterControl(dependencySetup, 'personId', ['Tenant', 'Person', 'Resident']));
  expect(await unitAfterProperty.inputValue()).toBe('');
  expect(await personAfterProperty.inputValue()).toBe('');
  await expect(runReportButton(page)).toBeEnabled();
  const beforeDependencyRun = reportRequests.length;
  await runReportButton(page).click();
  await expect.poll(() => reportRequests.length).toBeGreaterThan(beforeDependencyRun);
  await waitForReportResults(page);
  const dependencyRun = reportRequests.at(-1)!;
  expect(dependencyRun.query.propertyIds).toBe(expected.secondPropertyId);
  expect(dependencyRun.query.unitId).toBeUndefined();
  expect(dependencyRun.query.personId).toBeUndefined();
  expect(dependencyRun.query.tenancyId).toBeUndefined();

  // Selections survive reload and browser Back/reopen, but reopening a
  // report never turns the previous result into an implicit fresh run.
  await selectProperty(dependencySetup, expected.propertyId);
  await selectFilter(dependencySetup, 'unitId', expected.unitId, ['Unit']);
  await selectFilter(dependencySetup, 'personId', expected.personId, ['Tenant', 'Person', 'Resident']);
  await fillPeriod(dependencySetup, selected);
  const beforeReload = reportRequests.length;
  await page.reload();
  await expect(setupRoot(page)).toHaveCount(1);
  expect(reportRequests.length, 'reload does not auto-run').toBe(beforeReload);
  const reloadedSetup = setupRoot(page);
  expect(await (await firstVisible(filterControl(reloadedSetup, 'unitId', ['Unit']))).inputValue()).toBe(expected.unitId);
  expect(await (await firstVisible(filterControl(reloadedSetup, 'personId', ['Tenant', 'Person', 'Resident']))).inputValue()).toBe(expected.personId);
  await page.goto(`${origin}/ops?section=report-library&scope=all&asOf=${expected.asOfDate}`);
  await expect(page.getByRole('region', { name: 'Report library', exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'Report library', exact: true }).locator('[data-report-id="tenant-ledger"] .rops-report-open').click();
  await expect(setupRoot(page)).toHaveCount(1);
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Report library', exact: true })).toBeVisible();
  const reopenBefore = reportRequests.length;
  await page.getByRole('region', { name: 'Report library', exact: true }).locator('[data-report-id="tenant-ledger"] .rops-report-open').click();
  await expect(setupRoot(page)).toHaveCount(1);
  expect(reportRequests.length, 'cached report reopen does not auto-run').toBe(reopenBefore);

  // Export is tied to the applied run. Its URL/query must match the run that
  // produced the visible rows; local blob exports are checked by content too.
  const appliedSetup = setupRoot(page);
  await fillPeriod(appliedSetup, selected);
  await selectProperty(appliedSetup, expected.propertyId);
  await selectFilter(appliedSetup, 'unitId', expected.unitId, ['Unit']);
  await selectFilter(appliedSetup, 'personId', expected.personId, ['Tenant', 'Person', 'Resident']);
  await selectFilter(appliedSetup, 'tenantStatus', expected.status, ['Tenant status', 'Status']);
  await runReportButton(page).click();
  await expect.poll(() => reportRequests.filter((item) => item.kind === 'run' && item.report === selected.key).length).toBeGreaterThan(0);
  await waitForReportResults(page);
  const appliedRun = reportRequests.filter((item) => item.kind === 'run' && item.report === selected.key).at(-1)!;
  const beforeExportRunCount = reportRequests.filter((item) => item.kind === 'run' && item.report === selected.key).length;
  const beforeExportCsvCount = reportRequests.filter((item) => item.kind === 'csv' && item.report === selected.key).length;
  const exportResult = await clickExportCsv(page);
  await expect.poll(() => {
    const runCount = reportRequests.filter((item) => item.kind === 'run' && item.report === selected.key).length;
    const csvCount = reportRequests.filter((item) => item.kind === 'csv' && item.report === selected.key).length;
    return runCount > beforeExportRunCount || csvCount > beforeExportCsvCount;
  }).toBe(true);
  const exportRun = reportRequests.filter((item) => item.kind === 'run' && item.report === selected.key).at(-1);
  const csvRequest = reportRequests.filter((item) => item.kind === 'csv' && item.report === selected.key).at(-1);
  if (exportRun && reportRequests.filter((item) => item.kind === 'run' && item.report === selected.key).length > beforeExportRunCount) {
    expect(exportRun.query).toEqual(appliedRun.query);
  }
  if (csvRequest && reportRequests.filter((item) => item.kind === 'csv' && item.report === selected.key).length > beforeExportCsvCount) {
    expect(csvRequest.query).toEqual(appliedRun.query);
  }
  expect(exportResult.text).toMatch(/5Central|Property|Tenant|Balance|Demo Harbor|1A/i);
  expect(exportResult.text).not.toContain('Demo Grove');

  // Keyboard can reach and activate Run, and the active setup stays compact
  // on a second layout if this function is called for mobile.
  const runButton = runReportButton(page);
  await runButton.focus();
  expect(await runButton.evaluate((element) => document.activeElement === element)).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(await noHorizontalOverflow(page), 'report setup has no desktop horizontal overflow').toBe(false);
  await assertReportLayoutContained(page, browserName);
  return {
    browser: browserName,
    passed: true,
    reportCount: reports.length,
    setupEvidence: reportSetupEvidence,
    reportRequests: reportRequests.length,
    pageErrors,
    noOverflow: !(await noHorizontalOverflow(page)),
    elapsedMs: Math.round(performance.now() - started),
  };
}

async function runMobile(page: Page, browserName: string): Promise<Record<string, unknown>> {
  const started = performance.now();
  const reportRequests = attachReportRequestLog(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/ops?section=reports&report=rent-roll&scope=all&asOf=${expected.asOfDate}`);
  // Rent roll runs on open; the filter toggle then opens the full setup.
  await expect.poll(() => reportRequests.length).toBeGreaterThan(0);
  await waitForReportResults(page);
  const toggle = page.locator('.rm-report-filter-toggle').first();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(setupRoot(page)).toHaveCount(1);
  expect(await noHorizontalOverflow(page), 'report setup has no mobile horizontal overflow').toBe(false);
  const setup = setupRoot(page);
  await expect(setup).toBeVisible();
  expect(pageErrors).toEqual([]);
  await assertReportLayoutContained(page, `${browserName}-mobile`);
  const selectHeights = await mobileSelectHeights(page, setup);
  expect(selectHeights.every((field) => Number(field.height) >= 44), `${browserName}-mobile report selects meet the 44px touch target`).toBe(true);
  return { browser: browserName, viewport: { width: 390, height: 844 }, passed: true, noOverflow: true, reportRequests: reportRequests.length, pageErrors, selectHeights, elapsedMs: Math.round(performance.now() - started) };
}

try {
  const engines = (process.env.ROPS_BROWSERS ?? 'chromium,webkit').split(',').map(value => value.trim()).filter(Boolean);
  for (const [name, engine] of ([['chromium', chromium], ['webkit', webkit]] as const).filter(([name]) => engines.includes(name))) {
    const browser = await engine.launch({ headless: true, ...(name === 'chromium' && process.env.ROPS_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ROPS_CHROMIUM_EXECUTABLE } : {}) });
    try {
      const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      try {
        results.push(await runDesktop(desktop, name));
        await settleScreenshot(desktop);
        await desktop.screenshot({ path: resolve(output, `report-setup-${name}-desktop.png`), fullPage: true });
      } catch (error) {
        const diagnostics = pageDiagnostics.get(desktop);
        const pageState = await desktop.evaluate(() => ({ readyState: document.readyState, href: window.location.href })).catch(() => undefined);
        await desktop.screenshot({ path: resolve(output, `report-setup-${name}-desktop-failure.png`), fullPage: true });
        await writeFile(resolve(output, `report-setup-${name}-desktop-failure.txt`), await desktop.locator('body').innerText());
        await writeFile(resolve(output, `report-setup-${name}-desktop-failure.json`), JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          pageState,
          reportRequests: diagnostics?.reportRequests ?? [],
          pageErrors: diagnostics?.pageErrors ?? [],
          requestFailures: diagnostics?.requestFailures ?? [],
          consoleErrors: diagnostics?.consoleErrors ?? [],
        }, null, 2));
        throw error;
      } finally {
        await desktop.close();
      }
      const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        results.push(await runMobile(mobile, `${name}-mobile`));
        await settleScreenshot(mobile);
        await mobile.screenshot({ path: resolve(output, `report-setup-${name}-mobile.png`), fullPage: false });
      } finally {
        await mobile.close();
      }
    } finally {
      await browser.close();
    }
  }
  const report = {
    capturedAt: new Date().toISOString(),
    synthetic: true,
    buildMode: 'normal-client-synthetic-http-backend',
    reportTransport: 'http',
    origin,
    previewRoute: `${origin}/ops?section=dashboard&asOf=${expected.asOfDate}&scope=all`,
    syntheticDateConstraint: `Synthetic dashboard summary fixtures use asOf=${expected.asOfDate}; preview evidence keeps that fixed date instead of today's date.`,
    results,
    reportDefinitions: reports,
    evidence: output,
  };
  await writeFile(resolve(output, 'report-setup-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done()));
  await demo.close();
}
