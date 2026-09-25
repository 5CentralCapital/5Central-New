# Code Implementation — HTML/CSS/JS & React + Tailwind

Concrete tokens and recipes. Read alongside the HIG references (app UI) or marketing-pages (landing pages).

## Design tokens (drop-in CSS)

```css
:root {
  --font-stack: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text",
                Inter, "Helvetica Neue", Arial, sans-serif;

  /* HIG semantic tokens — light */
  --label: #000;
  --label-2: rgba(60,60,67,.60);
  --label-3: rgba(60,60,67,.30);
  --separator: rgba(60,60,67,.29);
  --bg: #fff;            --bg-2: #f2f2f7;      --bg-3: #fff;
  --bg-grouped: #f2f2f7; --bg-grouped-cell: #fff;
  --tint: #0088ff;  --green: #34c759;  --red: #ff383c;  --orange: #ff8d28;

  /* Marketing palette */
  --mk-text: #1d1d1f;  --mk-muted: #86868b;  --mk-surface: #f5f5f7;
  --mk-link: #0066cc;  --mk-cta: #0071e3;  --mk-cta-hover: #0077ed;
  --mk-dark-text: #f5f5f7;  --mk-dark-muted: #a1a1a6;  --mk-dark-link: #2997ff;

  --radius-pill: 980px;
  --ease-apple: cubic-bezier(0.28, 0.11, 0.32, 1);
}
.dark, [data-theme="dark"] {
  --label: #fff; --label-2: rgba(235,235,245,.60); --label-3: rgba(235,235,245,.30);
  --separator: rgba(84,84,88,.60);
  --bg: #000; --bg-2: #1c1c1e; --bg-3: #2c2c2e;
  --bg-grouped: #000; --bg-grouped-cell: #1c1c1e;
  --tint: #0091ff; --green: #30d158; --red: #ff4245; --orange: #ff9230;
}
body { font-family: var(--font-stack); -webkit-font-smoothing: antialiased; }
/* If Inter actually renders (non-Apple device / client work): */
body { font-feature-settings: "cv05", "cv11"; }
```

## Type scale

App UI (HIG, px = pt at 1x): Large Title 34/41 · Title1 28/34 · Title2 22/28 · Title3 20/25 · Headline 17/22 semibold · Body 17/22 · Callout 16/21 · Subheadline 15/20 · Footnote 13/18 · Caption 12/16.

Marketing headlines:
```css
h1.hero    { font-size: clamp(48px, 7vw, 96px); font-weight: 700; letter-spacing: -.022em; line-height: 1.05; }
h2.section { font-size: clamp(32px, 5vw, 56px); font-weight: 600; letter-spacing: -.015em; line-height: 1.08; }
p.subhead  { font-size: 21px; line-height: 1.4; color: var(--mk-muted); letter-spacing: .011em; }
```

## Liquid Glass recipe (CSS approximation)

Floating bar / island — the signature current-Apple element:

```css
.glass {
  background: rgba(255,255,255,.55);              /* dark mode: rgba(30,30,32,.55) */
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border-radius: 28px;                             /* capsule for bars: 999px */
  box-shadow:
    0 8px 32px rgba(0,0,0,.08),                    /* soft lift */
    inset 0 1px 0 rgba(255,255,255,.55),           /* specular top edge */
    inset 0 0 0 .5px rgba(255,255,255,.25);        /* glass rim */
}
.glass--clear { background: rgba(255,255,255,.18); } /* over media; add a 35%-black
                                                        dimming layer if content is bright */
```

Floating iOS-style tab bar:
```css
.tabbar {
  position: fixed; left: 50%; bottom: max(16px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  display: flex; gap: 8px; padding: 8px 12px; border-radius: 999px;
  /* + .glass properties */
}
.tabbar a { width: 56px; height: 44px; display: grid; place-items: center;
  border-radius: 999px; color: var(--label-2); }
.tabbar a[aria-current] { color: var(--tint); }   /* icons monochrome; active = tint */
```

Scroll edge effect (content fading under a floating top bar):
```css
.scroll-edge {
  position: fixed; inset: 0 0 auto 0; height: 96px; pointer-events: none;
  backdrop-filter: blur(8px);
  mask-image: linear-gradient(to bottom, black 30%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 30%, transparent 100%);
}
```
Key behavior: content scrolls edge-to-edge *beneath* bars (no `padding-top` shoving content down; use safe-area padding inside the scroller instead).

## Buttons

```css
.btn-filled {           /* prominent: ONE per view */
  background: var(--tint); color: #fff; font-size: 17px; font-weight: 600;
  padding: 13px 24px; border-radius: 999px; min-height: 44px;
  transition: opacity .2s var(--ease-apple), transform .2s var(--ease-apple);
}
.btn-filled:active { opacity: .8; transform: scale(.97); }  /* press = dim, never ripple */
.btn-gray   { background: var(--bg-2); color: var(--tint); /* same metrics */ }
.btn-plain  { background: none; color: var(--tint); }
.btn-destructive { color: var(--red); }
```
Marketing CTA: same pill, `--mk-cta` background, 12px/24px padding, hover lightens to `--mk-cta-hover` — no lift, no shadow.

## Grouped list (Settings style)

```css
.group { background: var(--bg-grouped-cell); border-radius: 10px; margin: 0 16px; overflow: hidden; }
.row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 11px 16px; font-size: 17px; }
.row + .row { border-top: .5px solid var(--separator); margin-left: 16px; padding-left: 0; }
.row .icon { width: 29px; height: 29px; border-radius: 7px; display: grid; place-items: center; color: #fff; }
.row .value { margin-left: auto; color: var(--label-2); }
.row .chevron { color: var(--label-3); }
.row:active { background: rgba(0,0,0,.05); }
```
Page background: `var(--bg-grouped)`. Toggle: 51×31px pill, `--green` on-state, white knob with `0 3px 8px rgba(0,0,0,.15)` shadow.

## Motion

Ease/duration defaults: `--ease-apple`, 0.3–0.4s; springs for interactive elements (Framer Motion: `type:"spring", stiffness:340, damping:30`).

GSAP reveal (subtle rise, settles fast, no bounce):
```js
gsap.utils.toArray('[data-reveal]').forEach(el => {
  gsap.from(el, { y: 28, opacity: 0, duration: .7, ease: 'power2.out',
    scrollTrigger: { trigger: el, start: 'top 85%', once: true } });
});
```
Pinned scrub and canvas image-sequence patterns: pin the section, `scrub: 0.6`, map progress → transform or frame index (≤120 frames). Pair with Lenis on marketing pages. Direction rule: whatever slides in from an edge dismisses back to that edge.

Always gate:
```js
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  ScrollTrigger.getAll().forEach(t => t.kill());
  document.querySelectorAll('[data-reveal]').forEach(el => el.removeAttribute('style'));
}
```

## React + Tailwind mapping

```js
// tailwind theme extension
extend: {
  colors: {
    label: 'var(--label)', label2: 'var(--label-2)',
    bg: { DEFAULT: 'var(--bg)', 2: 'var(--bg-2)', grouped: 'var(--bg-grouped)', cell: 'var(--bg-grouped-cell)' },
    tint: 'var(--tint)', sysgreen: 'var(--green)', sysred: 'var(--red)',
  },
  borderRadius: { cell: '10px', card: '22px', pill: '980px' },
  transitionTimingFunction: { apple: 'cubic-bezier(0.28,0.11,0.32,1)' },
}
```
Conventions: `<Button variant="filled|gray|plain|destructive">`; `<GlassBar>` wrapper applying the glass recipe; icons via lucide-react at consistent strokeWidth (1.8–2), sized to the adjacent text. Section wrapper for marketing: `py-24 md:py-36 text-center` with `max-w-[980px] mx-auto px-6`.

## Sheet (web approximation)

Bottom sheet: full-width card, top radius 16–20px, grabber (36×5px pill, `--separator`), scrim `rgba(0,0,0,.4)`, slides up 0.35s `--ease-apple`, drag-to-dismiss mirrors downward. Cancel leading / Done trailing in its top bar.

## Self-check for code output

Bars float (fixed, inset, rounded, glass) with content scrolling beneath — not opaque strips. One tinted primary per view. Press states dim/scale. 44px targets. `env(safe-area-inset-*)` respected. Reduced motion handled. Dark mode via tokens, not per-element overrides.
