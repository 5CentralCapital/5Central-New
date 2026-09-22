import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, webkit, expect, type Page } from '@playwright/test';
import { createCompanyDemoApp } from '../../server/company/demo';

const output = resolve(process.env.ROPS_EVIDENCE_DIR ?? '/tmp/rops-navigation-evidence');
await mkdir(output, { recursive: true });
const demo = await createCompanyDemoApp();
const listener = demo.app.listen(0, '127.0.0.1');
await new Promise<void>(done => listener.once('listening', done));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
const results: unknown[] = [];
const names = ['Dashboard', 'Properties', 'Tenants', 'Units', 'Accounting', 'Projects', 'Work Orders', 'Investors', 'Reporting', 'Company'];
async function openMenu(page: Page, name: string) {
  await expect(page.getByRole('menu')).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await nav.getByRole('button', { name, exact: true }).click();
  await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute('aria-expanded', 'true');
}
async function navigate(page: Page, group: string, item: string) {
  await openMenu(page, group);
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), 'No whole-page horizontal scrolling').toBe(false);
}
async function setTransparency(page: Page, value: string) {
  await openMenu(page, 'Company');
  const appearance = page.getByRole('menuitem', { name: 'Appearance', exact: true });
  await appearance.focus(); await page.keyboard.press('ArrowRight');
  await page.getByRole('menuitemradio', { name: value, exact: true }).click();
}
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const started = performance.now();
      await page.goto(`${origin}/ops?section=dashboard&asOf=2026-08-15&scope=all`);
      await expect(page.locator('.rmd-top-grid > section')).toHaveCount(6);
      await expect(page.locator('.rmd-trend-grid > section')).toHaveCount(3);
      const dashboardReadyMs = performance.now() - started;
      await expect(page.locator('.rm-sidebar, .rm-open-tabs, .rm-ribbon')).toHaveCount(0);
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect(nav.getByRole('button')).toHaveText(names);
      await expect(nav.locator('[aria-current]')).toHaveText('Dashboard');
      const accounting = nav.getByRole('button', { name: 'Accounting', exact: true });
      await accounting.focus(); await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Cash & banking', exact: true })).toBeFocused();
      await page.keyboard.press('Escape'); await expect(accounting).toBeFocused();
      await navigate(page, 'Tenants', 'Former tenants');
      await expect(page).toHaveURL(/tenantStatus=former/);
      await expect(page.locator('.rm-workspace-toolbar select').last()).toHaveValue('former');
      expect(new URL(page.url()).searchParams.get('asOf')).toBe('2026-08-15');
      expect(new URL(page.url()).searchParams.get('scope')).toBe('all');
      await navigate(page, 'Units', 'Unit records');
      await expect(page).toHaveURL(/kind=unit/);
      await expect(nav.locator('[aria-current]')).toHaveText('Units');
      await navigate(page, 'Accounting', 'Cash & banking');
      await expect(page).toHaveURL(/section=banking/);
      await expect(nav.locator('[aria-current]')).toHaveText('Accounting');
      await navigate(page, 'Accounting', 'Receivables');
      await expect(nav.locator('[aria-current]')).toHaveText('Accounting');
      await navigate(page, 'Units', 'Availability & occupancy');
      await expect(nav.locator('[aria-current]')).toHaveText('Units');
      await navigate(page, 'Properties', 'Rent roll');
      await expect(nav.locator('[aria-current]')).toHaveText('Properties');
      await navigate(page, 'Accounting', 'Cash & banking');
      await navigate(page, 'Reporting', 'Housing assistance');
      await expect(page).toHaveURL(/report=hap/);
      await page.goBack(); await expect(page).toHaveURL(/section=banking/);
      await navigate(page, 'Reporting', 'Report library');
      await expect(page).toHaveURL(/section=report-library/);
      const catalogResponse = await page.request.get(`${origin}/api/rent-ops/report-catalog`);
      expect(catalogResponse.ok()).toBe(true);
      const catalog = await catalogResponse.json();
      const library = page.getByRole('region', { name: 'Report library', exact: true });
      await expect(library.locator('[data-report-id]')).toHaveCount(catalog.reports.length);
      expect(catalog.reports.filter((report: { availability: string }) => report.availability === 'available')).toHaveLength(11);
      await library.getByRole('combobox', { name: 'Show reports' }).selectOption('available');
      // Company-executable reports also count as available once their engine is wired.
      await expect(library.locator('[data-report-id="rent-roll"]')).toHaveCount(1);
      expect(await library.locator('[data-report-id]').count()).toBeGreaterThanOrEqual(11);
      const rentRoll = library.locator('[data-report-id="rent-roll"]');
      await rentRoll.getByRole('button', { name: /Add .* to favorites/ }).click();
      await library.getByRole('combobox', { name: 'Show reports' }).selectOption('favorites');
      await expect(library.locator('[data-report-id]')).toHaveCount(1);
      await page.reload();
      await library.getByRole('combobox', { name: 'Show reports' }).selectOption('favorites');
      await expect(library.locator('[data-report-id]')).toHaveCount(1);
      await rentRoll.locator('.rops-report-open').click();
      await expect(page).toHaveURL(/report=rent-roll/);
      await expect(page.getByRole('region', { name: 'Rent Operations reports' })).toBeVisible();
      await page.goBack(); await expect(library).toBeVisible();
      await library.getByRole('textbox', { name: 'Search reports' }).fill('income statement');
      await expect(library.locator('[data-report-id]')).toHaveCount(4);
      // Income statement by unit is now a company report; it opens its setup rather than staying disabled.
      await page.screenshot({ path: resolve(output, `report-library-${name}.png`), fullPage: true });
      await library.getByRole('textbox', { name: 'Search reports' }).fill('');
      await library.getByRole('combobox', { name: 'Report category' }).selectOption('tasks');
      await expect(library.locator('[data-report-id]')).toHaveCount(6);
      await library.getByRole('textbox', { name: 'Search reports' }).fill('does-not-exist');
      await expect(library.getByText('No matching reports.', { exact: true })).toBeVisible();
      await openMenu(page, 'Investors');
      await expect(page.getByRole('menuitem', { name: 'Investor accounts', exact: true })).toBeEnabled();
      await page.keyboard.press('Escape');
      await openMenu(page, 'Work Orders');
      await expect(page.getByRole('menuitem', { name: 'Open work orders Planned', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');

      await navigate(page, 'Projects', 'Costs');
      await page.getByRole('button', { name: 'New project', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name', { exact: true }).fill(`Navigation ${name}`);
      await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('.projects-tabs button.is-active')).toHaveText('Costs');
      await navigate(page, 'Projects', 'Scope & budget');
      await expect(page.locator('.projects-tabs button.is-active')).toHaveText('Scope & Budget');
      const bookmark = page.url();
      await navigate(page, 'Projects', 'Schedule');
      await expect(page.locator('.projects-tabs button.is-active')).toHaveText('Schedule');
      await page.goBack(); await expect(page).toHaveURL(bookmark);
      await expect(page.locator('.projects-tabs button.is-active')).toHaveText('Scope & Budget');
      await page.reload(); await expect(page.locator('.projects-tabs button.is-active')).toHaveText('Scope & Budget');
      await page.getByRole('button', { name: 'Costs', exact: true }).click();
      await expect(page).toHaveURL(/projectTab=costs/);

      await setTransparency(page, 'Reduced');
      await expect(page.locator('.rops-topbar')).toHaveAttribute('data-transparency', 'reduced');
      expect(await page.locator('.rops-topbar').evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none');
      await page.reload(); await expect(page.locator('.rops-topbar')).toHaveAttribute('data-transparency', 'reduced');
      await setTransparency(page, 'System');
      await page.goto(`${origin}/ops?section=dashboard&asOf=2026-08-15&scope=all`);
      await expect(page.locator('.rmd-top-grid > section')).toHaveCount(6);
      await expect(page.locator('.rm-main')).not.toContainText('Loading portfolio summary…');
      await expect(page.locator('.rmd-chart')).toHaveCount(3);
      await page.screenshot({ path: resolve(output, `dashboard-${name}.png`), fullPage: true });
      await openMenu(page, 'Accounting');
      await page.screenshot({ path: resolve(output, `accounting-menu-${name}.png`) });
      await page.keyboard.press('Escape');

      const viewports = [];
      for (const viewport of [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        // Let the browser deliver media-query changes before the next input.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await noOverflow(page);
        await openMenu(page, 'Tenants');
        await expect(page.getByRole('menuitem', { name: 'Current tenants', exact: true })).toBeInViewport();
        await page.keyboard.press('Escape');
        if (viewport.width <= 1100) {
          await page.keyboard.press('Escape');
          await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
        }
        viewports.push(viewport);
      }
      await navigate(page, 'Properties', 'Property records');
      await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
      await noOverflow(page);
      await page.screenshot({ path: resolve(output, `properties-mobile-${name}.png`), fullPage: true });
      await navigate(page, 'Reporting', 'Report library');
      await expect(page.getByRole('region', { name: 'Report library' }).locator('[data-report-id="rent-roll"]')).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: resolve(output, `report-library-mobile-${name}.png`), fullPage: true });
      await navigate(page, 'Dashboard', 'Overview');
      await expect(page.locator('.rmd-top-grid > section')).toHaveCount(6);
      await page.screenshot({ path: resolve(output, `dashboard-mobile-${name}.png`), fullPage: true });
      await setTransparency(page, 'Reduced');
      await expect(page.locator('.rops-topbar')).toHaveAttribute('data-transparency', 'reduced');
      // A 1280px browser at 200% zoom has a 640 CSS-pixel layout viewport.
      await page.setViewportSize({ width: 640, height: 450 });
      await noOverflow(page);
      await navigate(page, 'Units', 'Unit records'); await noOverflow(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await setTransparency(page, 'System');
      await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'more' });
      await openMenu(page, 'Company');
      expect(await page.getByRole('menu').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
      expect(await page.locator('.rops-topbar').evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none');
      await page.keyboard.press('Escape');
      await page.emulateMedia({ forcedColors: 'active' }); await openMenu(page, 'Tenants');
      await expect(page.getByRole('menuitem', { name: 'Current tenants', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
      results.push({ browser: name, passed: true, dashboardReadyMs, viewports, synthetic: true, pageErrors: errors });
    } catch (error) {
      await writeFile(resolve(output, `failure-${name}.json`), JSON.stringify(await page.evaluate(() => ({
        focus: document.activeElement?.outerHTML,
        menus: Array.from(document.querySelectorAll('[role="menu"]')).map(element => ({ html: element.outerHTML, state: element.getAttribute('data-state'), rect: element.getBoundingClientRect().toJSON(), animation: getComputedStyle(element).animationName, opacity: getComputedStyle(element).opacity })),
      })), null, 2));
      await page.screenshot({ path: resolve(output, `failure-${name}.png`), fullPage: true });
      throw error;
    } finally { await browser.close(); }
  }
  await writeFile(resolve(output, 'navigation-results.json'), JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
  await demo.close();
}
