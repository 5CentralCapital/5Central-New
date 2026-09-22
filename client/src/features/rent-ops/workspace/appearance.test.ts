import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

const managerCss = readFileSync(new URL('../../../styles/rops-system.css', import.meta.url), 'utf8');
const workspaceCss = readFileSync(new URL('./workspace.css', import.meta.url), 'utf8');
const modernCss = readFileSync(new URL('./workspace-modern.css', import.meta.url), 'utf8');

function darkAppearanceRule(css: string) {
  return postcss.parse(css).nodes.find((node) =>
    node.type === 'atrule' && node.name === 'media' &&
    node.params.includes('prefers-color-scheme: dark') &&
    !node.params.includes('prefers-contrast'),
  );
}

function hexLuminance(value: string) {
  assert.match(value, /^#[\da-f]{6}$/i, `expected a solid six-digit hex color, got ${value}`);
  const [r, g, b] = value.slice(1).match(/[\da-f]{2}/gi)!.map((part) => parseInt(part, 16) / 255);
  const linear = [r, g, b].map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(first: string, second: string) {
  const a = hexLuminance(first);
  const b = hexLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('manager styles parse and retain the current light palette', () => {
  assert.doesNotThrow(() => postcss.parse(workspaceCss));
  assert.doesNotThrow(() => postcss.parse(modernCss));
  assert.doesNotThrow(() => postcss.parse(managerCss));
  assert.match(managerCss, /--ds-surface-muted:\s*#f3f2ee/);
  assert.match(managerCss, /--ds-row-hover:\s*rgb\(58 50 38 \/ 3\.5%\)/);
  assert.match(workspaceCss, /color-scheme:\s*light/);
});

test('dark manager text, status, primary action and focus tokens meet contrast targets', () => {
  const dark = darkAppearanceRule(managerCss);
  assert.ok(dark, 'expected a prefers-color-scheme: dark manager token block');

  const rootTokens: Record<string, string> = {};
  dark.walkRules((rule) => {
    if (rule.selector.includes('.rm-workspace.rops-modern') && rule.selector.includes('.rops-nav-menu')) {
      rule.walkDecls(/^--ds-/, (decl) => { rootTokens[decl.prop] = decl.value; });
    }
  });

  const surface = rootTokens['--ds-surface'];
  assert.ok(surface, 'dark palette defines an opaque feature surface');
  for (const token of ['--ds-ink', '--ds-ink-2', '--ds-muted', '--ds-faint', '--ds-gold-ink', '--ds-positive', '--ds-warning', '--ds-critical', '--ds-info']) {
    const ratio = contrastRatio(rootTokens[token], surface);
    assert.ok(ratio >= 4.5, `${token} contrast on the dark surface is ${ratio.toFixed(2)}:1`);
  }
  assert.ok(contrastRatio(rootTokens['--ds-primary-fg'], rootTokens['--ds-primary-bg']) >= 4.5);
  assert.ok(contrastRatio(rootTokens['--ds-focus-color'], surface) >= 4.5);

  assert.match(managerCss, /\.rm-workspace\.rops-modern\s*\{\s*color-scheme:\s*dark/s);
  assert.match(modernCss, /color-scheme:\s*inherit/);
});

test('dark tokens reach manager feature modules and the small-screen navigation surface', () => {
  const dark = darkAppearanceRule(managerCss);
  assert.ok(dark, 'expected a dark manager media block');
  const darkCss = dark.toString();
  for (const selector of ['.projects-workspace', '.intake-workspace', '.company-documents-workspace', '.rm-tenant-record', '.rmd-dashboard', '.reporting-workspace']) {
    assert.ok(darkCss.includes(selector), `dark feature overrides include ${selector}`);
  }
  assert.match(darkCss, /\.rops-primary-navigation\.is-open[\s\S]*?background:\s*var\(--ds-surface\)/);
  assert.match(darkCss, /\.rops-wordmark\s*>\s*span[\s\S]*?color:\s*var\(--ds-gold-ink\)/);
});
