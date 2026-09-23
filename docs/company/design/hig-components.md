# HIG Components — Bars, Buttons, Lists, Presentation, Controls

Synthesized from Apple's Human Interface Guidelines (mid-2026). The details below are what make a screen read as genuinely Apple.

## Tab bars (navigation between top-level sections)

- Navigation **only** — actions never live here; that's the toolbar's job.
- iOS: floats at the bottom as a capsule island on Liquid Glass; can **minimize on scroll-down** and restore on scroll-up/tap; may carry a distinct search item at the trailing end; can host an accessory (mini-player) that moves inline when minimized.
- iPadOS/macOS: tab bar sits near the top; can be convertible to a sidebar (`sidebarAdaptable`) — prefer tab bar first, sidebar for many/rarely-used sections. ≤5 default items.
- Filled SF Symbols + one-word labels. Never hide or disable a tab — show an empty state inside instead. Badges (red oval) only for genuinely critical info.

## Toolbars / navigation bars (actions on the current view)

- Three zones: **leading** (Back/Close, sidebar toggle, title), **center** (common actions; customizable on iPad/Mac; collapses to overflow first), **trailing** (critical persistent items: primary action, search, More).
- iOS **large title** transitions to inline title on scroll and back at top.
- Standard Back/Close symbols only — no "Back" text labels. Titles ≤15 characters; omit when redundant.
- Symbols preferred over text except unsymbolizable actions ("Edit"). No borders on bar buttons — the bar is the container. One `.prominent` (tint-background) action max, trailing side.
- ≤3 visual groups; separate navigation from destructive/commit actions; put fixed space between adjacent text buttons.
- macOS: every toolbar item must also exist as a menu-bar command.

## Sidebars

- Leading edge, top-level navigation with ≤2 levels of hierarchy (deeper → split view with a content column).
- Content scrolls beneath the floating sidebar; use a background extension effect under it.
- User-customizable contents; hideable but never hidden by default; SF Symbols, accent-colored selection (don't fix icon colors unless color means something).

## Buttons

Anatomy = **style** (prominence/shape) + **content** (symbol, label, both) + **role** (normal / primary / cancel / destructive).

- Hit region ≥ 44×44pt (60pt visionOS). Always design a pressed state (dim to ~80% opacity or slight scale — never ripples).
- **Prominent style** (tint-filled background, white label) for the single most likely action; 1–2 per view max. Distinguish importance by *style*, never by making one button bigger.
- Secondary styles: gray fill (`systemGray5`-family bg + tint label) and plain (tint text, no container).
- Roles: primary responds to Return and gets the accent; destructive renders red; never make a destructive action the default/primary; always pair destructive with Cancel.
- Labels start with a verb ("Add to Cart"), 1–2 words, title case. In-button spinner + label swap ("Checkout" → "Checking out…") for non-instant actions.
- Shapes: capsule for standalone/prominent CTAs, rounded-rect (~12–14pt radius, 50pt tall) for full-width primaries in forms, circle for icon-only.

## Lists & tables

- Lists for text; collections/grids for image-heavy or varied-size content.
- iOS grouped style: inset rounded groups (10pt radius) on the grouped background set; rows 44–52pt; separators inset to text alignment.
- Selection feedback: **navigation rows** highlight persistently to show the path; **option rows** flash then show a checkmark.
- Row anatomy: optional leading icon (29×29pt rounded-square, white glyph on flat color — Settings style), 17pt label, trailing secondary value, chevron `›` in tertiary gray. Info button (ⓘ) reveals detail *without* navigating; chevron navigates — don't confuse them.
- macOS: sortable, resizable columns; alternating row backgrounds for wide tables; outline views (disclosure triangles) for hierarchy.

## Sheets, alerts & modality

**Modality doctrine**: one modal at a time; simple scoped tasks only; obvious dismiss (top toolbar button or swipe-down on iOS; button in view on macOS); confirm before dismissing unsaved work; complex flows get full-screen or a window, not nested sheets.

**Sheets**: resizable with detents — `medium` (~half, for progressive disclosure like Share) and `large`; include the grabber (36×5pt pill) when resizable; compose-type tasks are full-height only. Buttons: Cancel/Close leading, Done (or a more specific verb) trailing; multi-step flows swap Cancel for Back after step 1. macOS sheets are rounded cards over a dimmed parent window. Nonmodal sheets (iOS) exist for panels that live alongside the parent (formatting palettes).

**Alerts**: critical + actionable only; never at launch, never purely informational, never for routine undoable deletes. Title = what happened and why, ≤2 lines, no "Error". Buttons: 1–3, verb titles ("Delete", "View All"); "OK" only for pure information; Cancel always cancels, sits leading/bottom, never the default; destructive style + Cancel always together.

**Action sheets / confirmation dialogs**: the follow-up to an intentional but risky tap ("Delete draft?") — not alerts.

**Popovers** (iPad/Mac): transient, anchored to their control, for lightweight tools/options; on iPhone they become sheets.

## Small controls

- **Toggles**: switch style only inside list rows (context = label); default green `#34c759` (accent acceptable); elsewhere use a toggle *button* with a filled active state. macOS: checkboxes for multi-select and hierarchies, radio buttons for 2–5 exclusive choices, switches for emphasized settings.
- **Segmented controls**: 2–5 segments (≤5 on iPhone), equal widths, nouns, text or icons but not mixed; for switching closely related subviews — separate app sections get a tab bar instead.
- **Text fields**: placeholder = purpose or format example, plus a persistent label for important fields; clear button trailing (iOS); secure entry for credentials; width hints at expected length; validate email-type fields on blur; number formatters, never regex-hardcoded formats.
- **Search fields**: icon + placeholder + clear; search-on-keystroke; suggestions early; scope control to filter; tokens for structured filters. iOS placement options: trailing search tab in the tab bar, bottom toolbar (search-first apps like Mail/Notes), or top trailing button expanding to a field; iPad/Mac: toolbar trailing (global) or top of sidebar (filtering nav).
- **Context menus**: touch-and-hold / right-click; only frequent, relevant items; ≤1 submenu level; every item must also exist somewhere visible; apply consistently across the whole app.
- **Progress**: determinate bar when duration is known, indeterminate spinner otherwise; prefer in-place skeletons/placeholder content over blocking spinners.

## Scroll behavior

- Elastic system scrolling only; make scrollability apparent by letting content peek at edges.
- Never nest same-orientation scroll views; orthogonal nesting is fine.
- Page-by-page: show a page control, hide the same-axis scroll indicator.
