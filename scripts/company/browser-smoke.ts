import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, webkit, expect } from '@playwright/test';
import { createCompanyDemoApp } from '../../server/company/demo';

const output = resolve(process.env.ROPS_EVIDENCE_DIR ?? '/tmp/rops-project-browser-evidence');
await mkdir(output, { recursive: true });
const demo = await createCompanyDemoApp();
const listener = demo.app.listen(0, '127.0.0.1');
await new Promise<void>(done => listener.once('listening', done));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
const results: unknown[] = [];
try {
  for (const [name, engine, viewport] of [
    ['chromium', chromium, { width: 1440, height: 1000 }],
    ['webkit', webkit, { width: 390, height: 844 }],
  ] as const) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => void dialog.accept());
    try {
      const started = performance.now();
      await page.goto(`${origin}/ops?section=projects`);
      await page.getByRole('button', { name: 'New project', exact: true }).first().click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name', { exact: true }).fill(`Synthetic ${name} renovation`);
      await dialog.getByLabel('Type', { exact: true }).selectOption('unit_turn');
      await dialog.getByLabel('Unit (optional)', { exact: true }).selectOption('demo-unit-a-1');
      await page.screenshot({ path: resolve(output, `project-editor-${name}.png`), fullPage: true });
      await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: `Synthetic ${name} renovation`, exact: true })).toBeVisible();
      await page.locator('.projects-detail-actions').getByRole('button', { name: 'Edit', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Description', { exact: true }).fill('Edited in the existing R-ops workspace');
      await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Scope & Budget', exact: true }).click();
      await page.getByRole('button', { name: 'Add scope item', exact: true }).first().click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Description', { exact: true }).fill('Flooring');
      await dialog.getByLabel('Quantity', { exact: true }).fill('2.5');
      await dialog.getByLabel('Rate', { exact: true }).fill('100.01');
      await dialog.getByRole('button', { name: 'Save scope item', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('cell', { name: '$250.03', exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Approve budget', exact: true }).click();
      await expect(page.getByText('Budget v1', { exact: false }).first()).toBeVisible();
      await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Flooring', exact: true }) }).first().getByRole('button', { name: 'Edit', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Quantity', { exact: true }).fill('3');
      await dialog.getByRole('button', { name: 'Save scope item', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Approve new budget', exact: true }).click();
      await expect(page.locator('.projects-budget-version').filter({ hasText: 'Budget v2' })).toContainText('$300.03');
      await expect(page.locator('.projects-budget-version').filter({ hasText: 'Budget v1' })).toContainText('$250.03');
      await page.getByRole('button', { name: 'Schedule', exact: true }).click();
      await page.getByRole('button', { name: 'Add task', exact: true }).first().click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Title', { exact: true }).fill('Install flooring');
      await dialog.getByRole('button', { name: 'Save task', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('cell', { name: 'Install flooring', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Costs', exact: true }).click();
      await page.getByRole('button', { name: 'Add draft cost', exact: true }).first().click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Description', { exact: true }).fill('Labor');
      await dialog.getByLabel('Amount', { exact: true }).fill('125.50');
      // The database commits but the response is lost. The visible retry must
      // carry the original envelope so no second cost is created.
      let dropResponse = true;
      const createCostRequests: string[] = [];
      await page.route('**/project-commands/project.draft_cost.create', async route => {
        createCostRequests.push(route.request().postData()!);
        const response = await route.fetch();
        if (dropResponse) { dropResponse = false; await route.abort('failed'); }
        else await route.fulfill({ response });
      });
      await dialog.getByRole('button', { name: 'Save draft cost', exact: true }).click();
      await dialog.getByRole('button', { name: 'Retry pending save', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(createCostRequests).toHaveLength(2);
      expect(createCostRequests[0]).toBe(createCostRequests[1]);
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Labor', exact: true }) });
      await expect(row).toContainText('$125.50');
      await row.getByRole('button', { name: 'Edit', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Amount', { exact: true }).fill('140.25');
      await dialog.getByRole('button', { name: 'Save draft cost', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(row).toContainText('$140.25');
      await page.reload();
      await expect(page.getByRole('heading', { name: `Synthetic ${name} renovation`, exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Costs', exact: true }).click();
      await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Labor', exact: true }) })).toContainText('$140.25');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect(overflow, 'No horizontal document overflow').toBe(false);
      expect(errors).toEqual([]);
      await page.screenshot({ path: resolve(output, `projects-${name}.png`), fullPage: true });
      await page.locator('.projects-detail-actions').getByRole('button', { name: 'Archive', exact: true }).click();
      await page.getByRole('combobox', { name: 'Project status', exact: true }).selectOption('archived');
      await page.getByRole('listitem').filter({ hasText: `Synthetic ${name} renovation` }).click();
      await expect(page.locator('.projects-detail-actions').getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Costs', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Add draft cost', exact: true })).toHaveCount(0);
      await page.goto(`${origin}/ops?section=dashboard`);
      await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
      await expect(page.locator('.rm-main')).not.toContainText('Loading portfolio summary…');
      await page.screenshot({ path: resolve(output, `existing-dashboard-${name}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      expect(errors).toEqual([]);
      results.push({ browser: name, viewport, passed: true, elapsedMs: performance.now() - started, pageErrors: errors, overflow, synthetic: true });
    } catch (error) {
      console.error(JSON.stringify({ browser: name, pageErrors: errors }));
      console.error(JSON.stringify(await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth,
        overflow: Array.from(document.querySelectorAll('*')).filter(element => element.getBoundingClientRect().right > window.innerWidth + 1)
          .slice(-20).map(element => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })) }))));
      await page.screenshot({ path: resolve(output, `projects-${name}-failure.png`), fullPage: true });
      await writeFile(resolve(output, `projects-${name}-failure.txt`), await page.locator('body').innerText());
      throw error;
    } finally { await browser.close(); }
  }
  const rows = await demo.database.db.query('SELECT amount_cents::text FROM company_project_draft_costs ORDER BY id');
  expect(rows.rows).toHaveLength(2);
  expect(rows.rows.every(row => row.amount_cents === '14025')).toBe(true);
  await writeFile(resolve(output, 'browser-results.json'), JSON.stringify({ results, liveAcceptance: false }, null, 2));
  console.log(JSON.stringify({ passed: true, browsers: results, evidence: output }));
} finally {
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
  await demo.close();
}
