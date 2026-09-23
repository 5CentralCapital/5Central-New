import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFile(path.join(repositoryRoot, file), "utf8");
const config = JSON.parse(await read("src-tauri/tauri.conf.json")) as {
  readonly identifier: string;
  readonly productName: string;
  readonly build: { readonly frontendDist: string };
  readonly app: { readonly withGlobalTauri: boolean; readonly security: { readonly capabilities: readonly unknown[]; readonly csp: string }; readonly windows: readonly unknown[] };
  readonly bundle: { readonly active: boolean; readonly targets: readonly string[]; readonly category: string; readonly icon: readonly string[]; readonly macOS: { readonly hardenedRuntime: boolean; readonly minimumSystemVersion: string; readonly entitlements: string } };
};
const policy = await read("src-tauri/src/policy.rs");
const shell = await read("src-tauri/src/lib.rs");
const launch = await read("desktop/launch/index.html");

test("the Mac app launches a bundled connection page, then the shared 5Central Ops manager on the canonical host", () => {
  // The bundle identifier is unchanged so window state and macOS permissions carry over.
  assert.equal(config.identifier, "com.5central.r-ops");
  assert.equal(config.productName, "5Central Ops");
  assert.equal(config.build.frontendDist, "../desktop/launch");
  // Same origin as RENT_OPS_PUBLIC_APP_URL, the Intuit redirect URI and admin sign-in; it survives the Replit-to-Render move.
  assert.match(policy, /DEFAULT_TARGET: &str = "https:\/\/5central\.capital\/ops"/);
  assert.match(launch, /"https:\/\/5central\.capital\/ops"/);
  for (const file of [policy, shell, launch]) assert.doesNotMatch(file.replace(/fn the_retired_replit_host[\s\S]*?\n    }\n/, ""), /replit\.app/);
  assert.match(launch, /window\.__ROPS_TARGET__/);
  assert.match(launch, /location\.replace\(target\)/);
  // The main window is created in Rust so it gets the navigation policy.
  assert.deepEqual(config.app.windows, []);
  assert.match(shell, /WebviewWindowBuilder::new\(app, MAIN, WebviewUrl::App\("index\.html"/);
  assert.match(shell, /\.on_navigation\(/);
  assert.match(shell, /\.on_new_window\(/);
});

test("remote content gets no native capabilities and the launch page is locked down", () => {
  assert.deepEqual(config.app.security.capabilities, []);
  assert.equal(config.app.withGlobalTauri, false);
  assert.match(config.app.security.csp, /default-src 'none'/);
  assert.match(launch, /Content-Security-Policy/);
});

test("everything stays in the app except mail and phone links", () => {
  assert.match(policy, /Decision::Viewer/);
  assert.match(policy, /"mailto" \| "tel" \| "sms" => Decision::System/);
  assert.doesNotMatch(shell, /open_external/);
  assert.match(shell, /fn open_viewer/);
});

test("iframes (Google sign-in, Plaid, Stripe) load; only top-level links go to the viewer", () => {
  // WebKit's navigation callback also fires for iframes, so it must police schemes, not hosts.
  assert.match(shell, /\.on_navigation\(move \|url\| match decide_frame\(/);
  assert.match(shell, /initialization_script\(link_router_script\(/);
  assert.match(shell, /\.on_page_load\(/);
  assert.match(policy, /"accounts\.youtube\.com"/);
});

test("one reusable viewer, zoom and print, and closing hides instead of quitting", async () => {
  assert.match(shell, /const VIEWER: &str = "viewer"/);
  assert.match(shell, /with_denylist\(&\[VIEWER\]\)/);
  assert.match(shell, /ZOOM_STEPS/);
  assert.match(shell, /\.print\(\)/);
  assert.match(shell, /RunEvent::Reopen/);
  assert.doesNotMatch(await read("src-tauri/Cargo.toml"), /single-instance/);
});

test("signed, hardened DMG with a real Mac icon", () => {
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.targets, ["app", "dmg"]);
  assert.equal(config.bundle.category, "Business");
  assert.equal(config.bundle.macOS.hardenedRuntime, true);
  assert.equal(config.bundle.macOS.entitlements, "entitlements.plist");
  assert.ok(config.bundle.icon.includes("icons/icon.icns"));
});

test("the Go menu mirrors the manager's top navigation: same categories, order and first destination", async () => {
  const { WORKSPACE_NAVIGATION, NAVIGATION_GROUP_LABELS, destinationRoute } = await import("../../client/src/features/rent-ops/workspace/navigation");
  const { parseWorkspaceRoute, workspaceRouteSearch } = await import("../../client/src/features/rent-ops/workspace/workspace-state");
  const entries = [...policy.matchAll(/\("go-[a-z-]+", "([^"]+)", "([^"]+)"\)/g)].map(match => ({ label: match[1]!, query: match[2]! }));
  assert.deepEqual(entries.map(entry => entry.label), [...NAVIGATION_GROUP_LABELS]);
  for (const [index, group] of WORKSPACE_NAVIGATION.entries()) {
    const destination = group.direct ?? group.items[0]!;
    const expected = new URLSearchParams(workspaceRouteSearch(destinationRoute(destination, parseWorkspaceRoute(""))));
    const actual = new URLSearchParams(entries[index]!.query);
    assert.equal(actual.get("section"), expected.get("section"), `${group.label} section`);
    for (const [key, value] of actual) assert.equal(expected.get(key), value, `${group.label} ${key}`);
  }
  assert.match(policy, /GO_SHORTCUT_COUNT: usize = 9/);
});
