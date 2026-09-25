# HIG Foundations — Color, Type, Layout, Materials, Icons, Motion, Accessibility

Synthesized from Apple's Human Interface Guidelines (mid-2026). Values are exact — use them, don't approximate.

## Materials & Liquid Glass

Two material families:

**Liquid Glass** — the functional layer (tab bars, toolbars, sidebars, floating buttons). Two variants:
- `regular` — blurs and adjusts luminosity of what's behind; the default for anything with significant text (sidebars, alerts, popovers, most bars).
- `clear` — highly translucent, shows background media through; only over visually rich content (photos, video). If the underlying content is bright, add a dark dimming layer at **35% opacity** behind clear glass.

Rules: glass takes color from behind it; small elements (tab bars, toolbars) flip light/dark based on underlying content with monochrome symbols; larger elements (sidebars) render more opaque for legibility. Never use glass in the content layer — exception: transient controls (a slider knob mid-drag) may briefly adopt it. If app content is colorful, keep bars monochrome.

**Standard materials** — content-layer separation, four thicknesses: `ultraThin`, `thin`, `regular` (default), `thick`. Thicker = better text contrast; thinner = more background context. Put *vibrant* system colors on top of materials so text adapts automatically.

**Scroll edge effect** — the transition where content meets a floating bar: `automatic` (default; progressive blur + fade), `soft`, or `hard` (opaque boundary — only when tested). Use only adjacent to floating elements, one per scroll view.

## Color

**Semantic first.** Colors are named by purpose, not appearance, and adapt to light/dark/increased-contrast automatically. Never hard-code where a token exists; never repurpose (no `separator` as text).

iOS/iPadOS backgrounds — two sets, each with 3 levels (primary = whole view, secondary = grouping, tertiary = grouping within grouping):
- **System set**: `#ffffff` / `#f2f2f7` / `#ffffff` (light); `#000000` / `#1c1c1e` / `#2c2c2e` (dark)
- **Grouped set** (Settings-style lists): inverse pairing — `#f2f2f7` page with `#ffffff` cells (light); `#000000` page with `#1c1c1e` cells (dark)
- Dark mode has **base** and **elevated** background variants (sheets/popovers brighten one step to convey depth).

Foreground: `label` #000/#fff; `secondaryLabel` rgba(60,60,67,.60) / rgba(235,235,245,.60); `tertiaryLabel` at .30 opacity; `quaternaryLabel` at .18/.16; `placeholderText` = tertiary; `separator` rgba(60,60,67,.29) / rgba(84,84,88,.60).

System tints (light / dark, current values):

| Color | Light | Dark |
|---|---|---|
| Blue (default tint) | `#0088ff` | `#0091ff` |
| Red | `#ff383c` | `#ff4245` |
| Green | `#34c759` | `#30d158` |
| Orange | `#ff8d28` | `#ff9230` |
| Yellow | `#ffcc00` | `#ffd600` |
| Mint | `#00c8b3` | `#00dac3` |
| Teal | `#00c3d0` | `#00d2e0` |
| Cyan | `#00c0e8` | `#3cd3fe` |
| Indigo | `#6155f5` | `#6d7cff` |
| Purple | `#cb30e0` | `#db34f2` |
| Pink | `#ff2d55` | `#ff375f` |
| Brown | `#ac7f5e` | `#b78a66` |

Grays: `systemGray` #8e8e93 (both modes), then gray2–gray6 light: #aeaeb2, #c7c7cc, #d1d1d6, #e5e5ea, #f2f2f7; dark: #636366, #48484a, #3a3a3c, #2c2c2e, #1c1c1e.

Never rely on color alone to convey state — pair with shape, icon, or label. Use Display P3 for rich imagery with sRGB fallbacks.

## Typography

System font SF Pro (serif: New York). Prefer Regular/Medium/Semibold/Bold; avoid Ultralight–Light, especially small.

**iOS/iPadOS text styles at the default (Large) Dynamic Type size** — size/leading in pt, with emphasized weight:

| Style | Weight | Size/Leading | Emphasized |
|---|---|---|---|
| Large Title | Regular | 34/41 | Bold |
| Title 1 | Regular | 28/34 | Bold |
| Title 2 | Regular | 22/28 | Bold |
| Title 3 | Regular | 20/25 | Semibold |
| Headline | Semibold | 17/22 | — |
| Body | Regular | 17/22 | Semibold |
| Callout | Regular | 16/21 | Semibold |
| Subheadline | Regular | 15/20 | Semibold |
| Footnote | Regular | 13/18 | Semibold |
| Caption 1 | Regular | 12/16 | Semibold |
| Caption 2 | Regular | 11/13 | Semibold |

**macOS text styles**: Large Title 26/32, Title 1 22/26, Title 2 17/22, Title 3 15/20, Headline 13/16 Bold, Body 13/16, Callout 12/15, Subheadline 11/14, Footnote 10/13, Caption 10/13. macOS has no Dynamic Type.

Minimums: iOS 11pt, macOS 10pt, tvOS 23pt (default 29), watchOS 12pt (default 16), visionOS 12pt (default 17). Support text enlargement to 200%; when text grows, keep hierarchy relative and let labels wrap rather than truncate; if you must truncate list items, prefer a centered ellipsis so start and end survive.

## Layout

- Screen margins: 16pt (iPhone), 20pt (large phones/iPad); spacing on a 4/8 grid (4, 8, 12, 16, 20, 24, 32).
- **Safe areas are law** — content respects Dynamic Island, home indicator, and floating bars; backgrounds and artwork extend edge-to-edge *behind* them. When content doesn't span the window (sidebar layouts), use a background extension effect so the sidebar floats over continued artwork.
- Reading order: top→bottom, leading→trailing (mirrors in RTL). Most important content top-leading.
- Group with space first; then background shapes, materials, or separators — in that order of preference.
- Avoid full-width edge-to-edge buttons on iOS; inset to margins and align to safe areas.
- Progressive disclosure: partially visible items at an edge invite scrolling; disclosure controls for depth.
- Current reference frames: iPhone 17 Pro 402×874pt, 17 Pro Max 440×956pt, iPhone 16 393×852pt (all @3x); iPad Pro 11″ 834×1210pt; design app UI at these, not 375×667.
- macOS: nothing critical at the window bottom (often offscreen); tvOS safe zone 60pt top/bottom, 80pt sides.

## SF Symbols & icons

- Use SF Symbols for all interface glyphs — 9 weights matching SF text weights, 3 scales (small/medium/large relative to cap height), so a symbol next to a Semibold 17pt label is Semibold and aligns automatically.
- Rendering modes: Monochrome (default), Hierarchical (one color, layered opacity = depth), Palette (color per layer), Multicolor (intrinsic colors). Gradient rendering exists for large sizes.
- Variant convention: **outline in toolbars and lists; fill in iOS tab bars and selections**. System pickers often choose automatically. Enclosed variants help tiny sizes; slash = unavailable.
- Symbol animations (bounce = action occurred, pulse = ongoing, replace = state change, wiggle = attention, draw-on = progress) — one meaning per animation, applied sparingly.
- In web/Figma work where SF Symbols aren't licensed: Lucide is the closest stroke match; keep one family and one stroke weight throughout, never mix.
- **App icons**: 1024×1024 layered (background + foreground layers), built for the system's Liquid Glass treatment (specular highlights, refraction) via Icon Composer. Six appearances: default, dark, clear light/dark, tinted light/dark. One concept, filled overlapping shapes, no photos, no text, no UI replicas; system applies the mask — never pre-round corners.

## Motion

- Purposeful only; never the sole carrier of information. System components animate themselves — don't re-animate standard interactions.
- Feedback motion mirrors the gesture: a sheet that slides up dismisses by sliding down. Keep it brief and cancellable.
- Springs over duration curves for interactive elements; scroll-linked (scrub) motion for content reveals.
- Reduce Motion on: replace zooms/z-depth/blur animations with fades, tighten springs, keep gesture-tracking motion.

## Accessibility numbers

Control sizes (default / minimum): iOS & watchOS 44×44 / 28×28pt; macOS 28×28 / 20×20pt; tvOS 66×66 / 56×56pt; visionOS 60×60 / 28×28pt. Pad ~12pt around bezeled controls, ~24pt around bare glyphs.

Contrast: 4.5:1 for text ≤17pt; 3:1 for ≥18pt or bold; meet it in light *and* dark, or at least when Increase Contrast is on. Every gesture needs an on-screen alternative; every element needs a VoiceOver label; no auto-dismissing timed UI.
