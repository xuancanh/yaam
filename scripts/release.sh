#!/usr/bin/env bash
# Build, sign, and publish a YAAM release with OTA artifacts.
#
#   scripts/release.sh              # release the version in tauri.conf.json
#
# Requires: the updater signing key at ~/.tauri/yaam.key (or the key content in
# TAURI_SIGNING_PRIVATE_KEY), and an authenticated `gh` CLI for the release.
# The DMG's Finder layout needs Finder-automation permission, so run this from
# your own terminal, not a sandboxed shell (add SKIP_DMG_LAYOUT=1 to force the
# plain layout instead).
set -euo pipefail

cd "$(dirname "$0")/../app"

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
TAG="v${VERSION}"
BUNDLE=src-tauri/target/release/bundle

# the tauri CLI only honors the key CONTENT variable, not the _PATH variant
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  TAURI_SIGNING_PRIVATE_KEY=$(cat "$HOME/.tauri/yaam.key")
fi
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

if git -C .. rev-parse "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "tag ${TAG} already exists — bump the version first" >&2
  exit 1
fi

echo "── building ${TAG}"
npm run build:mobile
if ! npm run tauri build; then
  # The DMG's Finder icon-layout AppleScript fails without Automation
  # permission (sandboxed/CI shells). The app bundle and updater artifacts
  # are already built at that point — regenerate just the DMG with the
  # plain layout, which needs no Finder scripting.
  echo "── full build failed; rebuilding without DMG, then plain-layout DMG"
  # updater artifacts are emitted after the DMG step, so the failed run never
  # produced them — this app-only build does (fast: everything is cached)
  npm run tauri build -- --bundles app
  (
    cd "${BUNDLE}/macos"
    rm -f ../dmg/*.dmg rw.*.dmg
    bash ../dmg/bundle_dmg.sh --skip-jenkins --volname YAAM \
      --icon YAAM.app 180 170 --app-drop-link 480 170 --window-size 660 400 \
      --hide-extension YAAM.app --volicon ../dmg/icon.icns \
      "../dmg/YAAM_${VERSION}_aarch64.dmg" YAAM.app
  )
fi

APP_TGZ="${BUNDLE}/macos/YAAM.app.tar.gz"
SIG_FILE="${APP_TGZ}.sig"
DMG="${BUNDLE}/dmg/YAAM_${VERSION}_aarch64.dmg"
UPDATER_TGZ_NAME="YAAM_${VERSION}_aarch64.app.tar.gz"

for f in "$APP_TGZ" "$SIG_FILE" "$DMG"; do
  [[ -f "$f" ]] || { echo "missing artifact: $f" >&2; exit 1; }
done

echo "── writing latest.json"
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT
cp "$APP_TGZ" "${STAGING}/${UPDATER_TGZ_NAME}"
node -e "
  const fs = require('fs')
  fs.writeFileSync('${STAGING}/latest.json', JSON.stringify({
    version: '${VERSION}',
    pub_date: new Date().toISOString(),
    platforms: {
      'darwin-aarch64': {
        signature: fs.readFileSync('${SIG_FILE}', 'utf8').trim(),
        url: 'https://github.com/xuancanh/yaam/releases/download/${TAG}/${UPDATER_TGZ_NAME}',
      },
    },
  }, null, 2))
"

echo "── publishing ${TAG}"
git -C .. tag "$TAG"
git -C .. push origin "$TAG"
gh release create "$TAG" \
  --title "YAAM ${VERSION}" \
  --generate-notes \
  "$DMG" \
  "${STAGING}/${UPDATER_TGZ_NAME}" \
  "${STAGING}/latest.json"

echo "── done: https://github.com/xuancanh/yaam/releases/tag/${TAG}"
