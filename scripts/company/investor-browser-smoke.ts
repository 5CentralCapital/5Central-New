import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, webkit, expect } from '@playwright/test';
import { createCompanyDemoApp } from '../../server/company/demo';

const output = resolve(process.env.ROPS_EVIDENCE_DIR ?? '/tmp/rops-investor-browser-evidence');
await mkdir(output, { recursive: true });
const results: unknown[] = [];
for (const [name, engine, viewport] of [
  ['chromium', chromium, { width: 1440, height: 1000 }],
  ['webkit', webkit, { width: 390, height: 844 }],
] as const) {
  const demo = await createCompanyDemoApp({ publicDir: process.env.ROPS_PUBLIC_DIR });
  const listener = demo.app.listen(0, '127.0.0.1');
  await new Promise<void>(done => listener.once('listening', done));
  const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const browser = await engine.launch({ headless: true });
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${origin}/ops?section=investors`);
    await page.getByRole('button', { name: 'New investor', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Account name', { exact: true }).fill('Synthetic investment account');
    await dialog.getByLabel('Create a new company contact', { exact: true }).check();
    await dialog.getByLabel('Contact name', { exact: true }).fill('Synthetic investor');
    await dialog.getByRole('button', { name: 'Create investor', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: /Synthetic investment account/ }).click();
    await page.getByRole('button', { name: 'Add investment', exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Synthetic private note');
    await dialog.getByLabel('Type', { exact: true }).selectOption('private_loan');
    await dialog.getByLabel('Committed amount', { exact: true }).fill('10000.00');
    await dialog.getByLabel('Principal face value', { exact: true }).fill('10000.00');
    await dialog.getByLabel('Effective from', { exact: true }).fill('2026-01-01');
    await dialog.getByLabel('Maturity (optional)', { exact: true }).fill('2027-01-01');
    await dialog.getByLabel('Demo Harbor Homes', { exact: true }).check();
    expect(await dialog.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await page.screenshot({ path: resolve(output, `investor-editor-${name}.png`), fullPage: true });
    await dialog.getByRole('button', { name: 'Create investment', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Synthetic private note', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Monthly payments', exact: true }).click();
    await page.getByRole('button', { name: 'Record payment', exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Payment kind', { exact: true }).selectOption('interest');
    await dialog.getByLabel('Interest', { exact: true }).fill('125.25');
    await dialog.getByRole('button', { name: 'Record manually', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/^(?:USD |\$)125\.25$/).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(/^(?:USD |\$)125\.25$/).first()).toBeVisible();
    const payments = await demo.database.db.query<{ amount_cents: string; status: string }>('SELECT amount_cents::text,status FROM company_investor_payments');
    expect(payments.rows).toEqual([{ amount_cents: '12525', status: 'manual_recorded' }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(output, `investor-monthly-${name}.png`), fullPage: true });
    await page.goto(`${origin}/ops?section=time`);
    await expect(page.getByRole('heading', { name: 'Employee time', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect QuickBooks Time', exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: resolve(output, `time-unconfigured-${name}.png`), fullPage: true });
    expect(errors).toEqual([]);
    results.push({ browser: name, status: 'passed', manualPaymentCents: '12525', providerPostingCreated: false });
  } catch (error) {
    await page.screenshot({ path: resolve(output, `failure-${name}.png`), fullPage: true });
    await writeFile(resolve(output, `failure-${name}.txt`), await page.locator('body').innerText());
    results.push({ browser: name, status: 'failed', error: String(error), errors });
    process.exitCode = 1;
  } finally {
    await browser.close();
    await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
    await demo.close();
  }
}
await writeFile(resolve(output, 'browser-results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
