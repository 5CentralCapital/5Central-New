# HIG Patterns — Flows, States, and UX Writing

Synthesized from Apple's Human Interface Guidelines (mid-2026). These are the invisible details that make a flow feel Apple-designed.

## Launching & first run

- Launch fast; restore previous state (scroll position, last location) on every relaunch — never make people retrace steps.
- Launch screen (iOS/iPadOS/tvOS) mimics the app's first screen so startup *feels* instant — it is not a branding moment: no text, no logo, static only.
- Splash screens, if unavoidable: first step of onboarding, glance-length, never blocking on downloads.

## Onboarding

- Best onboarding is none. If needed: teach by doing, not by reading; prefer contextual tips at the moment of relevance over an upfront tour; always skippable, never repeated, findable later in help/settings.
- Sensible defaults over setup questionnaires; never ask what the system can detect (dark mode, device, controller).
- Permission prompts: at the moment the feature needs them, with a clear reason — inside onboarding only if the app can't function without them.
- Don't prompt for ratings or purchases before genuine engagement.

## Loading & progress

- Show something immediately — placeholder/skeleton content that gets replaced beats any spinner; a blank screen reads as broken.
- Keep the rest of the app interactive while loading in the background.
- Determinate progress when duration is known; something interesting (tips, previews) for unavoidably long loads.

## Feedback & errors

- Integrate status into the interface near the thing it describes (unread count in the toolbar), not in interruptions.
- Confirm success only when it genuinely matters (a payment, not a save).
- Warn before *unexpected, irreversible* loss only — intentional deletion doesn't need a speed bump; accidental-prone, non-undoable actions do.
- When a command fails, say what went wrong and how to fix it, next to where it went wrong.

## Empty states

Centered symbol (48–64pt, tertiary color) → short Title 3 heading → one Footnote/Subheadline line → one action button. Generous space. Empty states are temporary — never park crucial information there.

## Settings

- The best setting is one nobody needs to change: pick great defaults, detect what you can, keep the count small.
- Placement: task-specific options inline in the affected view; general rarely-changed options in an in-app settings area; system-level things link out to the Settings app.
- Never duplicate systemwide settings (appearance, accessibility) inside the app.
- Describe what a toggle does when **on**; people infer off. Label first, description only if the label can't carry it.

## Search

- Search as you type; suggestions before typing (recents, popular); most relevant results first, categorized when useful; scope bar to filter.
- Choose the entry point deliberately (see components file for iOS/iPad/macOS placements) — search-first apps put it in the bottom toolbar or a dedicated tab.

## UX writing (Apple voice)

- Every word earns its place; read it aloud; plain language, no jargon, no gendered terms.
- **Buttons/links**: active verbs — "Send", not "Let's do it!"; links say what they open ("Learn more about billing"), never "Click here". "Tap" on touch devices, "click" on Mac.
- **Capitalization**: pick per element type and never mix — Title Case for buttons, nav titles, and menu items; Sentence case for body, descriptions, and settings labels.
- **Flows**: "Get Started" opens, "Continue" *or* "Next" (pick one) advances, "Done" closes.
- **Pronouns**: "Favorites" over "Your Favorites"; never "we" in errors ("Unable to load content", not "We're having trouble"); if using my/your, don't switch perspective.
- **Errors**: specific and positive — "Choose a password with at least 8 characters" beats "Password too short"; no "Oops!"/"Uh-oh"; place the message at the field, not in an alert.
- **Alerts**: titles state what happened and why; fragments get Title Case without punctuation, sentences get sentence case with a period; don't explain the buttons in the body.

## Dark Mode behavior

- Never offer an in-app light/dark override of the system setting; support both, test with Increase Contrast and Reduce Transparency.
- Dark palettes dim backgrounds and *brighten* foregrounds — not an inversion. Elevated surfaces (sheets, popovers) step one background level brighter.
- Slightly darken white-heavy imagery for dark contexts; permanently-dark UI is only for immersive media apps.

## Platform feel deltas

- **iOS**: one-hand reach — key controls middle/bottom; swipe-back everywhere; list-row swipe actions; quick sessions, instant resume.
- **iPadOS**: design full-size first, degrade gracefully to any window size; convertible tab bar/sidebar; pointer + keyboard supported.
- **macOS**: denser (13pt body, 28pt controls); every command in the menu bar; keyboard shortcuts for everything; resizable, customizable, multi-window; hover states matter; Command-Comma opens Settings (toolbar-pane window, remembers last pane).
- **watchOS**: edge-to-edge content (bezel is the padding), vertical-first scrolling via Digital Crown, capsule buttons, full-width primaries, ≤2 text buttons side by side, no spinners — notify when done.
- **visionOS**: center the important content, 60pt center-to-center between controls, glass windows (don't fill them opaque), toolbar as bottom ornament, no head-anchored content.
