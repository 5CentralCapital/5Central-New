import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, webkit, expect, type Page } from '@playwright/test';
import { createCompanyDemoApp } from '../../server/company/demo';
import { WORKSPACE_NAVIGATION } from '../../client/src/features/rent-ops/workspace/navigation';

// Requires a built client (npm run build → dist/public, or ROPS_PUBLIC_DIR) and Playwright browsers.
// ROPS_BROWSERS=chromium limits the run to the engines installed on this machine.
const output = resolve(process.env.ROPS_EVIDENCE_DIR ?? '/tmp/rops-navigation-evidence');
await mkdir(output, { recursive: true });
const demo = await createCompanyDemoApp({ publicDir: process.env.ROPS_PUBLIC_DIR });
const listener = demo.app.listen(0, '127.0.0.1');
await new Promise<void>(done => listener.once('listening', done));
const origin = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
const results: unknown[] = [];
const names = ['Dashboard', 'Properties', 'Tenants', 'Units', 'Accounting', 'Projects', 'Work Orders', 'Investors', 'Reporting', 'Company'];
const menus = names.slice(1);
const engines = (process.env.ROPS_BROWSERS ?? 'chromium,webkit').split(',').map(value => value.trim()).filter(Boolean);

async function ensureNavigation(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  if (!(await nav.isVisible())) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  return nav;
}
async function openMenu(page: Page, name: string) {
  await expect(page.getByRole('menu')).toHaveCount(0);
  const nav = await ensureNavigation(page);
  await nav.getByRole('button', { name, exact: true }).click();
  await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute('aria-expanded', 'true');
}
async function navigate(page: Page, group: string, item: string) {
  await openMenu(page, group);
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}
async function openDashboard(page: Page) {
  const nav = await ensureNavigation(page);
  await nav.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page).toHaveURL(/section=dashboard/);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), 'No whole-page horizontal scrolling').toBe(false);
}
async function setTransparency(page: Page, value: string) {
  await page.getByRole('button', { name: /^Account(:|$)/ }).click();
  const appearance = page.getByRole('menuitem', { name: 'Appearance', exact: true });
  await appearance.focus(); await page.keyboard.press('ArrowRight');
  await page.getByRole('menuitemradio', { name: value, exact: true }).click();
}
try {
  for (const [name, engine] of ([['chromium', chromium], ['webkit', webkit]] as const).filter(([engineName]) => engines.includes(engineName))) {
    // ROPS_CHROMIUM_EXECUTABLE points at a locally installed Chromium when Playwright's pinned build is absent.
    const browser = await engine.launch({ headless: true, ...(name === 'chromium' && process.env.ROPS_CHROMIUM_EXECUTABLE ? { executablePath: process.env.ROPS_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const started = performance.now();
      await page.goto(`${origin}/ops?section=dashboard&asOf=2026-08-15&scope=all`);
      await expect(page.locator('.rmd-top-grid > section')).toHaveCount(6);
      await expect(page.locator('.rmd-trend-grid > section')).toHaveCount(3);
      const dashboardReadyMs = performance.now() - started;
      await expect(page).toHaveTitle('5Central Ops — Dashboard');
      await expect(page.locator('.rm-sidebar, .rm-open-tabs, .rm-ribbon')).toHaveCount(0);
      await expect(page.locator('.rmd-company-grid')).toBeVisible();
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await expect(nav.getByRole('link', { name: 'Dashboard', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(nav.getByRole('button')).toHaveText(menus);
      await expect(nav.locator('[aria-current]')).toHaveText('Dashboard');

      // Keyboard: open a menu, move within it, choose with Enter; Escape returns focus to the trigger.
      const accounting = nav.getByRole('button', { name: 'Accounting', exact: true });
      await accounting.focus(); await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Overview', exact: true })).toBeFocused();
      await page.keyboard.press('Escape'); await expect(accounting).toBeFocused();
      const properties = nav.getByRole('button', { name: 'Properties', exact: true });
      await properties.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('menuitem', { name: 'All properties', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('menuitem', { name: 'Performance', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/section=property-performance/);
      await expect(page.getByRole('heading', { level: 1, name: 'Performance' })).toBeVisible();

      // No placeholder entries anywhere; every destination opens a working view.
      for (const group of WORKSPACE_NAVIGATION.filter(item => !item.direct)) {
        await openMenu(page, group.label);
        await expect(page.getByRole('menuitem')).toHaveText(group.items.map(item => item.label));
        await expect(page.locator('[role="menuitem"][data-disabled]')).toHaveCount(0);
        await expect(page.getByRole('menu')).not.toContainText('Planned');
        await page.keyboard.press('Escape');
        for (const item of group.items) {
          await navigate(page, group.label, item.label);
          await expect(page).toHaveURL(new RegExp(`section=${item.section}(&|$)`));
          await expect(nav.locator('[aria-current]')).toHaveText(group.label);
          await expect(page.locator('#rops-content')).not.toBeEmpty();
        }
      }

      // Tenant status is the Directory filter; portfolio date and scope survive navigation.
      await navigate(page, 'Tenants', 'Directory');
      await page.locator('.rm-workspace-toolbar').getByRole('combobox').last().selectOption('former');
      await expect(page).toHaveURL(/tenantStatus=former/);
      expect(new URL(page.url()).searchParams.get('asOf')).toBe('2026-08-15');
      expect(new URL(page.url()).searchParams.get('scope')).toBe('all');
      await navigate(page, 'Units', 'All units');
      await expect(page).toHaveURL(/kind=unit/);
      await expect(nav.locator('[aria-current]')).toHaveText('Units');
      await navigate(page, 'Accounting', 'Banking & reconciliation');
      await expect(page).toHaveURL(/section=accounting.*acctView=banking|acctView=banking.*section=accounting/);
      await navigate(page, 'Units', 'Availability');
      await expect(page).toHaveURL(/report=occupancy/);
      await expect(nav.locator('[aria-current]')).toHaveText('Units');
      await page.goBack(); await expect(page).toHaveURL(/acctView=banking/);

      // Old bookmarks still open their views. Investor Activity is now a real tab, so its link stays put.
      for (const [legacy, expected] of [['section=income', /section=collections/], ['section=banking', /acctView=banking/], ['section=documents', /section=property-documents/], ['section=projects&projectTab=costs', /projectTab=budget/], ['section=investors&investorTab=activity', /investorTab=activity/]] as const) {
        await page.goto(`${origin}/ops?${legacy}&asOf=2026-08-15&scope=all`);
        await expect(page).toHaveURL(expected);
        await expect(page.locator('#rops-content')).not.toBeEmpty();
      }

      await navigate(page, 'Reporting', 'Report library');
      await expect(page).toHaveURL(/section=report-library/);
      const library = page.getByRole('region', { name: 'Report library', exact: true });
      await expect(library.locator('[data-report-id="rent-roll"]')).toHaveCount(1);
      const rentRoll = library.locator('[data-report-id="rent-roll"]');
      await rentRoll.locator('.rops-report-open').click();
      await expect(page).toHaveURL(/report=rent-roll/);
      await page.goBack(); await expect(library).toBeVisible();
      await page.screenshot({ path: resolve(output, `report-library-${name}.png`), fullPage: true });

      await navigate(page, 'Projects', 'Budgets & costs');
      await page.getByRole('button', { name: 'New project', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name', { exact: true }).fill(`Navigation ${name}`);
      await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/projectTab=budget/);
      const bookmark = page.url();
      await navigate(page, 'Projects', 'Schedule');
      await expect(page.locator('.projects-tabs button.is-active')).toHaveText('Schedule');
      await page.goBack(); await expect(page).toHaveURL(bookmark);
      await page.reload(); await expect(page).toHaveURL(/projectTab=budget/);

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
        await expect(page.getByRole('menuitem', { name: 'Directory', exact: true })).toBeInViewport();
        await page.keyboard.press('Escape');
        if (viewport.width <= 1100) {
          await page.keyboard.press('Escape');
          await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
        }
        viewports.push(viewport);
      }
      await navigate(page, 'Properties', 'All properties');
      await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
      await noOverflow(page);
      await page.screenshot({ path: resolve(output, `properties-mobile-${name}.png`), fullPage: true });
      await navigate(page, 'Reporting', 'Report library');
      await expect(page.getByRole('region', { name: 'Report library' }).locator('[data-report-id="rent-roll"]')).toBeVisible();
      await noOverflow(page);
      await openDashboard(page);
      await expect(page.locator('.rmd-top-grid > section')).toHaveCount(6);
      await page.screenshot({ path: resolve(output, `dashboard-mobile-${name}.png`), fullPage: true });
      await setTransparency(page, 'Reduced');
      await expect(page.locator('.rops-topbar')).toHaveAttribute('data-transparency', 'reduced');
      // A 1280px browser at 200% zoom has a 640 CSS-pixel layout viewport.
      await page.setViewportSize({ width: 640, height: 450 });
      await noOverflow(page);
      await navigate(page, 'Units', 'All units'); await noOverflow(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await setTransparency(page, 'System');
      await page.emulateMedia({ reducedMotion: 'reduce', contrast: 'more' });
      await openMenu(page, 'Company');
      expect(await page.getByRole('menu').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
      expect(await page.locator('.rops-topbar').evaluate(element => getComputedStyle(element).backdropFilter)).toBe('none');
      await page.keyboard.press('Escape');
      await page.emulateMedia({ forcedColors: 'active' }); await openMenu(page, 'Tenants');
      await expect(page.getByRole('menuitem', { name: 'Directory', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
      results.push({ browser: name, passed: true, dashboardReadyMs, viewports, synthetic: true, pageErrors: errors });
    } catch (error) {
      await writeFile(resolve(output, `failure-${name}.json`), JSON.stringify(await page.evaluate(() => ({
        url: location.href,
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
