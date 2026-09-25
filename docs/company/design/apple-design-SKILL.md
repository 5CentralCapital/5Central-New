---
name: apple-design
description: Apply Apple's current design language (Human Interface Guidelines + Liquid Glass, mid-2026) to any UI work — app interfaces in the iOS/iPadOS/macOS style, and marketing/landing pages in the Apple.com style (huge headlines, alternating light/dark sections, scroll-driven product reveals). Use this skill whenever the user asks for "Apple style", "Apple-like", "HIG", "iOS style", "macOS style", "Liquid Glass", "iOS 26 style", "Cupertino", a "clean premium minimal" landing page, or a product page that feels like an iPhone/Mac launch page — even if they don't say "Apple" explicitly but describe frosted glass, floating tab bars, pill buttons, giant centered headlines, or scroll-scrubbed product animations. Also use when reviewing/critiquing a design for Apple-platform fit. Works for HTML/CSS/JS prototypes, React + Tailwind, and Figma design guidance.
---

# Apple Design (HIG + Liquid Glass edition)

This skill makes output actually *feel* Apple — not "generic minimal with more whitespace". The difference lives in specific numbers (type scales, radii, hit targets, easing) and in a philosophy of restraint. Specs here are synthesized from Apple's Human Interface Guidelines as of mid-2026, which means the current **Liquid Glass** design language, not the pre-2025 flat look.

## The one thing to know first: Liquid Glass

Since 2025, Apple platforms separate every screen into two layers:

1. **Content layer** — the app's actual content. Extends edge-to-edge, scrolls under everything, uses opaque backgrounds and standard materials.
2. **Functional layer (Liquid Glass)** — controls and navigation (tab bars, toolbars, sidebars, buttons) that *float above* content on a dynamic glass material. It has no color of its own; it refracts what's beneath, adapts light/dark from the underlying content, and keeps symbols monochrome by default.

Practical rules: bars are floating rounded/capsule islands, not full-width strips glued to edges. Content visibly scrolls beneath them. A *scroll edge effect* (progressive blur/fade) separates floating controls from content — never a hard hairline by default. Color on glass is reserved: tint the **background** of at most one prominent action (e.g. Done); everything else stays monochrome. Don't build content-layer cards out of glass — glass is for interactive chrome only.

## Route to the right reference

| Deliverable | Read |
|---|---|
| App UI — any screen, component, or flow | `references/hig-foundations.md` + `references/hig-components.md` |
| UX flows, copy, empty/error/loading states, onboarding, settings, search | `references/hig-patterns.md` |
| Marketing/landing/product page | `references/marketing-pages.md` |
| HTML/CSS/JS or React+Tailwind build (tokens, glass recipes, motion code) | `references/code-implementation.md` (in addition to the above) |
| Figma work (frames, variables, text styles, effects) | `references/figma-workflow.md` (in addition to the above) |

Mixed requests (landing page showing app screenshots): marketing rules govern the page; HIG rules govern anything depicted as an app.

## Core philosophy (applies to everything)

Apple's stated principles — purpose, agency, responsibility, familiarity, flexibility, simplicity, craft, delight — cash out in practice as:

- **One idea per screen/section.** Each view makes one point with one hero element. If it feels busy, cut elements; don't shrink them.
- **Content first, chrome recedes.** Controls float above and stay minimal; content owns the screen edge-to-edge.
- **Typography carries hierarchy** — dramatic size/weight jumps, not boxes and borders. Body 17pt (iOS) / 13pt (macOS); headlines are several steps up, never one.
- **Near-monochrome chrome.** Tint marks *interactivity* — anything tinted looks tappable, so never tint static decoration. One or two tinted elements per view, maximum.
- **Depth through material, not shadow stacks.** Glass, background-level steps (system → secondary → tertiary), and hairlines at 8–30% opacity. Shadows only for genuinely floating things, soft and low-opacity.
- **Motion is physics, tied to input.** Springs and scroll-linked transforms that settle fast; direction of dismissal mirrors direction of arrival; always honor Reduce Motion.
- **Forgiveness.** Easy undo, obvious dismiss, confirmation only for non-undoable destruction.

## Font strategy (read before choosing fonts)

Apple's SF Pro / SF Compact / New York fonts are licensed for Apple-platform design and development only:

- **Prototypes viewed on Apple devices**: use the system stack — `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Arial, sans-serif` — which renders true SF on Mac/iPhone.
- **Client production work / non-Apple distribution**: recommend **Inter** (with `font-feature-settings: "cv05", "cv11"` for SF-like letterforms) and tell the client why. Never embed SF font files in deliverables.
- **In Figma**: SF Pro is fine (free for design), Inter as fallback.
- SF is a variable font with dynamic optical sizing; mimic it by tightening tracking as size grows: ~`-0.003em` at 17px → `-0.015em` at 48px → `-0.022em` at 80px+.

## Quality bar — self-check before delivering

1. Could one more element be removed? (Usually yes — do it.)
2. Do bars/controls float over content with a scroll edge effect, or are they opaque strips? (Strips = pre-2025.)
3. Is anything tinted that isn't interactive? Is more than one control's *background* tinted?
4. Are hit targets ≥ 44×44pt (28×28 macOS) with breathing room?
5. Do buttons read as Apple capsules/rounded-rects — not 1px-outlined rectangles (Material) and no ripple effects (Android)?
6. Dark surfaces: `#000` base with elevated `#1c1c1e`-family steps, text `#f5f5f7`-family — never pure white text?
7. Does every gesture have an on-screen alternative, and every destructive action a Cancel?
8. Would a casual observer accept a screenshot of this as an Apple app / apple.com?

If the user's brand conflicts with strict Apple rules (e.g., a gold hotel accent), keep the structure and restraint and swap only the tint color — and say you're doing this.
