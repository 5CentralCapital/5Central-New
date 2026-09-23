# Figma Workflow — Apple Design

Setting up Apple-style work in Figma, whether giving guidance or building via Figma MCP tools (if using MCP, load the figma-use skill first).

## Frames

- iOS app: **393×852** (iPhone 16/17 class) or 402×874 (17 Pro); design at @1x in points.
- iPadOS: 834×1210 (11″ Pro) or 1024×1366 (13″).
- macOS app: 1440×900 window, 10 corner radius.
- Marketing desktop: 1440×auto (verify at 1024); marketing mobile: 390×auto.

## Variables (one collection, Light + Dark modes)

**App (HIG) collection** — bind every fill/text to these, hardcode nothing:

| Variable | Light | Dark |
|---|---|---|
| label/primary | `000000` | `FFFFFF` |
| label/secondary | `3C3C43` 60% | `EBEBF5` 60% |
| label/tertiary | `3C3C43` 30% | `EBEBF5` 30% |
| separator | `3C3C43` 29% | `545458` 60% |
| bg/primary | `FFFFFF` | `000000` |
| bg/secondary | `F2F2F7` | `1C1C1E` |
| bg/tertiary | `FFFFFF` | `2C2C2E` |
| bg/grouped | `F2F2F7` | `000000` |
| bg/groupedCell | `FFFFFF` | `1C1C1E` |
| tint | `0088FF` | `0091FF` |
| green | `34C759` | `30D158` |
| red | `FF383C` | `FF4245` |
| orange | `FF8D28` | `FF9230` |

**Marketing collection**: `text/primary 1D1D1F`, `text/secondary 86868B`, `surface/default FFFFFF`, `surface/alt F5F5F7`, `surface/dark 000000`, `text/onDark F5F5F7`, `text/onDarkSecondary A1A1A6`, `accent/link 0066CC`, `accent/linkDark 2997FF`, `accent/cta 0071E3`.

## Text styles

Font: **SF Pro** (free from Apple for design use); fallback **Inter**.

App set (name / size / line height / weight — create both regular and emphasized where noted):
LargeTitle 34/41 Regular (emph Bold) · Title1 28/34 · Title2 22/28 · Title3 20/25 (emph Semibold) · Headline 17/22 Semibold · Body 17/22 · Callout 16/21 · Subheadline 15/20 · Footnote 13/18 · Caption1 12/16 · Caption2 11/13. macOS set is denser: Body 13/16, Title1 22/26, LargeTitle 26/32.

Marketing set: `Hero/80 Bold, -2.2%` · `H2/56 Semibold, -1.5%` · `H3/32 Semibold, -1%` · `Eyebrow/24 Semibold` · `Body/21 Regular, +1%, LH 140%` · `Body-S/17` · `Footnote/12`.

## Liquid Glass in Figma

Recipe for a floating bar/island:
1. Frame with corner radius 999 (capsule) or 28 (island); fill `FFFFFF` 55% (dark: `1E1E20` 55%).
2. **Background blur 24** (effect — background blur, not layer blur).
3. Inner shadow: Y 1, blur 0, `FFFFFF` 55% (specular top edge).
4. Inside stroke 0.5, `FFFFFF` 25% (rim).
5. Drop shadow: Y 8, blur 32, `000000` 8%.

Place bars **over** content in the layer stack; let a screenshot/artwork layer run beneath to prove the float. Add a "scroll edge" rectangle above content at bar edges: fill = bg color, gradient fade to 0%, plus background blur 8 if the plugin/version allows blur masking.

## Auto layout values

- 4/8 grid: spacing tokens 4, 8, 12, 16, 20, 24, 32. Screen margins 16 (iPhone) / 20 (iPad).
- iOS grouped list: container radius 10, rows min-height 44 with 16 horizontal padding, 0.5 separator inset 16; leading icon 29×29 radius 7.
- Buttons: prominent capsule = padding 13/24, radius 999, min height 44; form primary = height 50, radius 14; iOS switch 51×31.
- Floating tab bar: capsule, padding 8/12, item 56×44, gap 8, pinned 16 from bottom + home-indicator space.
- Marketing section: vertical auto layout, 120 gap between sections; inside: 24 gap eyebrow→headline→subhead, 40 copy→visual, 120/64 top-bottom padding desktop/mobile; bento gap 20, card radius 22.

## Component build order (Apple-style library)

Variables → text styles → Button (Filled/Gray/Plain/Destructive × sizes, with pressed variants) → Floating tab bar (icon items w/ active boolean) → Toolbar/nav bar (large + inline title variants) → List row (icon/value/chevron/toggle props) → Toggle → Segmented control → Search field → Sheet template (grabber + Cancel/Done bar) → Alert → Empty state → Marketing: nav, section template, link-arrow, bento card.

Use variants + component properties (booleans for icon/chevron, instance-swap for symbols, text props for labels). Icons: SF Symbols plugin or Lucide at uniform stroke; match icon optical size to adjacent text size.

## Review checklist in Figma

Every fill bound to a variable (test by switching mode) · bars float with glass recipe · one tint-filled action per screen · 44pt targets · type only from styles · dark mode actually checked, not assumed.
