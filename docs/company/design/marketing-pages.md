# Apple.com-Style Marketing Pages

How Apple product pages are actually constructed. Use these patterns for landing pages, product launches, and feature pages.

## Page anatomy

A typical Apple product page is a vertical stack of full-bleed sections, alternating light (`#fff` / `#f5f5f7`) and dark (`#000`). Each section = one feature, one hero visual, minimal copy. Order:

1. **Global nav** — 44–48px tall, frosted glass, ~12px links, centered, max-width ~1024px
2. **Hero** — product name huge, one-line tagline, two links, giant product image
3. **Feature sections** × N — alternating backgrounds
4. **Comparison / specs strip** (optional)
5. **Footer** — dense small links on `#f5f5f7`, 12px text, `#424245` borders

## The section formula

Every Apple feature section follows this exact copy structure. Use it verbatim as a template:

```
[Eyebrow]        — 21–28px, semibold, often gray or gradient, names the feature area
[Headline]       — 48–80px, weight 600–700, the single big claim. Short. Punchy.
[Subhead/body]   — 19–21px, #86868b on light / #a1a1a6 on dark, 2–3 lines max
[Links]          — "Learn more >" (#0066cc) and/or pill CTA "Buy"
[Hero visual]    — enormous, centered, often bleeding off-section
```

Copywriting voice: short declarative fragments. "Lightning fast. Lightyears ahead." Sentence fragments are fine. Superlatives are earned by a spec, not stacked. Never bullet-point feature lists in hero sections — one claim at a time.

## Signature visual moves (pick 1–2 per page, not all)

- **Gradient headline text** — a key word or whole headline filled with a vivid gradient (`background-clip: text`) on a black section. Apple's classic "supercharged" move.
- **Scroll-scrubbed product sequence** — a pinned section where scrolling scrubs through an image sequence or transforms the product (rotate, explode, zoom). Implementation in `code-implementation.md`.
- **Sticky headline, scrolling visuals** — headline pins while feature cards/images scroll past.
- **Bento grid** — a specs/feature summary as a grid of rounded cards (18–28px radius) with mixed spans, each card one stat or claim. Dark cards on black, or white cards on `#f5f5f7`.
- **Device frame showcase** — UI screenshots always live inside an accurate device frame, never floating raw.
- **Horizontal card rail** — edge-bleeding horizontally scrollable cards with snap points (how Apple shows camera features, colors).

## Layout numbers

- Content max-width: 980–1024px for text blocks; visuals may bleed to viewport edge
- Section vertical padding: 100–150px desktop, 60–80px mobile
- Headline max-width: ~800px, centered
- Body/subhead max-width: ~600px, centered
- Grid gutters: 20–24px; bento gap: 16–20px
- Everything centered by default; left-alignment only inside cards or split layouts

## Dark sections

- Background pure `#000`, text `#f5f5f7` (never `#fff` — it vibrates)
- Secondary text `#a1a1a6`
- Links shift to lighter blue `#2997ff`
- Cards on dark: `#1d1d1f` background, optional `1px solid rgba(255,255,255,0.08)` hairline
- Dark sections are where gradient text and dramatic product photography live

## Nav bar spec

- Height 44–48px, `position: sticky/fixed`
- Background: `rgba(251,251,253,0.8)` light / `rgba(22,22,23,0.8)` dark, `backdrop-filter: saturate(180%) blur(20px)`
- Links: 12px, `#1d1d1f` at ~80% opacity, 400 weight, ~24–32px apart
- Hairline bottom border only after scroll begins
- Current-era alternative (matches Liquid Glass system aesthetic): a floating pill/island nav — rounded-999px glass capsule inset from the top edge rather than a full-width strip. Use the `.glass` recipe from `code-implementation.md`. Pick one style per page; full-width is classic apple.com, floating pill is the newer product-page look.

## What breaks the illusion (avoid)

- Drop shadows on buttons or nav
- More than one accent color
- Icon grids with tiny icons + paragraph blurbs (that's SaaS-template, not Apple)
- Headlines under 40px on desktop
- Busy hero with badge + headline + subhead + 2 buttons + trust logos + screenshot all at once
- `ease-in-out` default easing or bouncy springs on scroll reveals
