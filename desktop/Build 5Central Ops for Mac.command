#!/bin/bash
# Double-click in Finder to build 5Central Ops for Mac. Produces an unsigned DMG unless
# APPLE_SIGNING_IDENTITY (and notarization credentials) are set — see docs/company/desktop-app.md.
set -euo pipefail
cd "$(dirname "$0")/.."
exec > >(tee desktop/last-build.log) 2>&1
TOOLS="$HOME/Projects/r-ops-tools/rust"
if [ -x "$TOOLS/cargo/bin/cargo" ]; then
  export CARGO_HOME="$TOOLS/cargo" RUSTUP_HOME="$TOOLS/rustup" PATH="$TOOLS/cargo/bin:$PATH"
fi
command -v cargo >/dev/null || { echo "Rust is not installed. Install from https://rustup.rs and run again."; read -n1 -rp "Press any key to close"; exit 1; }
[ -d node_modules/@tauri-apps/cli ] || npm install --no-audit --no-fund
echo "▸ Checking the app configuration…"
npx tsx --no-cache --test scripts/company/desktop-config.test.ts
(cd src-tauri && cargo test --quiet)
echo "▸ Building 5Central Ops for Mac (first build takes a few minutes)…"
npx tauri build --config src-tauri/tauri.conf.json --bundles app
APP="src-tauri/target/release/bundle/macos/5Central Ops.app"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
OUT_DIR="src-tauri/target/release/bundle/dmg"
DMG="$OUT_DIR/5Central-Ops_${VERSION}_$(uname -m).dmg"
echo "▸ Packaging the installer…"
hdiutil detach "/Volumes/5Central Ops" -quiet 2>/dev/null || true
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
mkdir -p "$OUT_DIR"; rm -f "$DMG" "$OUT_DIR"/rw.*.dmg
hdiutil create -volname "5Central Ops" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
rm -rf "$STAGE"
hdiutil verify "$DMG" >/dev/null && echo "✓ Built: $DMG"
open -R "$DMG"
read -n1 -rp "Press any key to close"
