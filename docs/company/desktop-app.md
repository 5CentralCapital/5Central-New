# 5Central Ops for Mac

5Central Ops for Mac (formerly "R-ops for Mac") is a native window for the hosted manager at the canonical host, `https://5central.capital/ops`. It uses the same sign-in, company database, server-side commands and QuickBooks connection as the web app and the Codex MCP. Interface changes ship with the normal web release, so they appear in the app without a rebuild. Only changes to the shell itself (`src-tauri/`, `desktop/launch/`) need a new DMG.

**Staying in sync with web releases.** Every screen, report, QuickBooks flow and fix reaches the app as soon as the web release is published, because the app loads the live manager. The shell needs a rebuild only when one of these changes, and `npm run desktop:check` (part of `npm run test:company`) fails until the shell is updated:

- the canonical host (`DEFAULT_TARGET` in `src-tauri/src/policy.rs`; it matches `RENT_OPS_PUBLIC_APP_URL`, the Intuit redirect URI and admin sign-in, and does not change when hosting moves from Replit to Render because DNS moves instead);
- the manager's top navigation (`WORKSPACE_NAVIGATION` in `client/src/features/rent-ops/workspace/navigation.ts`) — the Go menu is drift-tested against it;
- sign-in or QuickBooks consent hosts (`AUTH_HOSTS`).

The bundle identifier stays `com.5central.r-ops`, so window size/position and macOS permissions carry over. Because the product name changed, the new build installs as **5Central Ops.app**; delete the old **R-ops.app** from Applications after installing it.

## What the shell adds

- **Launch page** (`desktop/launch/index.html`, bundled). It shows the 5Central Ops mark, checks that the server answers, then opens the manager. If the server can't be reached it shows "Can't reach 5Central Ops" and retries every 10 seconds and whenever the Mac comes back online. It follows light and dark appearance.
- **Everything stays in the app.**
  - The main window loads 5Central Ops pages, manager sign-in (Auth0 → Google) and Intuit's QuickBooks consent screens, so Connect/Reconnect QuickBooks completes and returns to Accounting.
  - Any other web page, including `target=_blank` links, opens in **one reusable in-app viewer window** titled with the site's name. A manager link clicked inside the viewer returns to the main window.
  - Embedded frames always load in place. That covers Google sign-in's `accounts.youtube.com` frame, Plaid, Stripe and PDF previews. WebKit reports iframe navigations to the shell without saying they are frames, so the shell polices only schemes there (`decide_frame`). Top-level link clicks are routed by a small main-frame link router plus `on_new_window`. If a script navigates the main window to another site, `on_page_load` moves that page to the viewer and returns the manager.
  - Only `mailto:`, `tel:` and `sms:` links are handed to macOS (Mail, FaceTime).
  - `javascript:`, `file:`, `data:` and unknown schemes are blocked.
  - The policy and its tests are in `src-tauri/src/policy.rs`.
- **Mac menu bar:** 5Central Ops · File (Print ⌘P, Close Window ⌘W) · Edit (cut, copy, paste, select all work in forms) · View (Reload ⌘R, Actual Size ⌘0, Zoom In ⌘+, Zoom Out ⌘−, Full Screen) · Go (Back ⌘[, Forward ⌘], then the manager's ten categories in the same order as the web top navigation: Dashboard ⌘1, Properties ⌘2, Tenants ⌘3, Units ⌘4, Accounting ⌘5, Projects ⌘6, Work Orders ⌘7, Investors ⌘8, Reporting ⌘9, Company) · Window (5Central Ops ⌘⇧0 brings the manager back) · Help (Contact Support). Reload, zoom, print, Back and Forward act on whichever window is in front.
- **Window:** 1440×960 by default, minimum 1024×680. Size and position are remembered. The title bar is transparent and tinted to 5Central Ops' background (`#f6f4ef` light, `#1e1e1c` dark) and follows appearance changes. Closing the main window (⌘W or the red button) hides it, like Mail. Clicking the Dock icon brings it back, and ⌘Q quits. macOS keeps the app single-instance, so the single-instance plugin is not used; it crashed on Linux.
- **Downloads:** exports and statements save to `~/Downloads`. The Dock icon bounces once when a download finishes.
- **Icon:** a charcoal squircle with a gold stepped skyline; the source is `src-tauri/icons/icon-source.svg`. It contains no text, per Apple's icon guidance. Regenerate with `npx @tauri-apps/cli icon src-tauri/icons/icon-1024.png -o src-tauri/icons`, then delete the android/ios/Square* outputs.

## Security model

- Remote pages get **no Tauri capabilities**: `capabilities: []`, `withGlobalTauri: false`. All native behavior (menus, window policy, viewer windows, downloads) runs in Rust, so a compromised page cannot touch files, shell or native APIs.
- The launch page has a strict CSP (`default-src 'none'`). The app stores no QuickBooks tokens, database credentials or company data. The server keeps them, as on the web.
- Tauri's guidance prefers bundled frontends. Here the trusted 5Central Ops origin is loaded remotely, and that is deliberate: it keeps one same-origin session and makes web releases update the app instantly. If native integrations are ever added, move to a bundled UI with a reviewed token bridge; never grant capabilities to remote content.
- **Google sign-in:** Google refuses sign-in from browsers it classifies as embedded web views. The window presents Safari's user agent so the manager's Google (Auth0) sign-in can complete in its WKWebView, which keeps a real cookie store. If Google ever blocks it, use 5Central Ops password sign-in, or add a system-browser sign-in handoff: a one-time server code exchanged in the app. That is a server change owned by the 5Central Ops release process.

## Build

Build on the Mac, since Linux cannot produce a macOS bundle:

```sh
npm ci
npm run desktop:check                 # config/policy contract (Node)
(cd src-tauri && cargo test)          # navigation policy unit tests
npm run desktop:dev                   # run against production (https://5central.capital/ops)
npm run desktop:build                 # → src-tauri/target/release/bundle/dmg/5Central-Ops_1.0.0_arm64.dmg (double-click `desktop/Build 5Central Ops for Mac.command`; it runs the config and policy tests, then packages the DMG with hdiutil)
R_OPS_URL=https://<staging>/ops npm run desktop:build   # point a build at staging
```

Unsigned builds open with right-click → Open the first time.

## Signing and notarization (before sharing the DMG)

1. Get an Apple Developer ID Application certificate ($99/yr Apple Developer Program) into the login keychain.
2. `export APPLE_SIGNING_IDENTITY="Developer ID Application: 5Central Capital LLC (TEAMID)"`
3. `export APPLE_ID=… APPLE_PASSWORD=<app-specific password> APPLE_TEAM_ID=…` (or `APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH`).
4. `npm run desktop:build`. Tauri signs with the hardened runtime (`entitlements.plist` grants only outbound network), then notarizes and staples.
5. Verify with `spctl -a -vvv -t install src-tauri/target/release/bundle/dmg/*.dmg`, then do a clean-Mac install and first launch.

The Tauri updater is intentionally off. Interface updates arrive through the web release; shell releases are signed and distributed by hand.

## Acceptance checklist (run on the Mac)

- [ ] First launch shows the launch page, then the manager. Signing in with Google works in-window, and no extra window appears.
- [ ] With Wi-Fi off, the launch page shows "Can't reach 5Central Ops" and recovers automatically when Wi-Fi returns.
- [ ] ⌘1–⌘9 (and Go ▸ Company) open the same first page as each web top-navigation category; ⌘[ / ⌘] navigate; ⌘R reloads; ⌘C/⌘V work in forms.
- [ ] Accounting → Connect QuickBooks opens Intuit consent in the main window and returns to Accounting.
- [ ] `/legal/eula` stays in the main window. An external link (for example Intuit help) opens in a viewer window. A mailto link opens Mail.
- [ ] Exporting a report saves to ~/Downloads.
- [ ] Quit and relaunch restores window size and position. ⌘W hides the window and clicking the Dock icon restores it.
- [ ] ⌘P prints the current page; ⌘+ / ⌘− / ⌘0 zoom.
- [ ] Title bar matches the app in light and dark appearance.
