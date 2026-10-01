#!/bin/sh
# Builds, signs and notarizes the universal app on this Mac using the credentials in
# .env.release, then verifies the result the same way the release workflow does.
# This is a rehearsal for the release workflow, not a replacement for it.
set -eu
cd "$(dirname "$0")/.."

if [ ! -f .env.release ]; then
  echo "Missing .env.release. Copy .env.release.example to .env.release and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env.release
set +a

for name in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "$name is empty in .env.release." >&2
    exit 1
  fi
done

if ! security find-identity -v -p codesigning | grep -q "Developer ID Application: .*($APPLE_TEAM_ID)"; then
  echo "No Developer ID Application certificate for team $APPLE_TEAM_ID is in the keychain." >&2
  echo "Check: security find-identity -v -p codesigning" >&2
  exit 1
fi

echo "Building, signing and notarizing with team $APPLE_TEAM_ID. Signing takes a few minutes; notarization adds a quiet wait of a few more."
npm run build:release

app="dist/mac-universal/Agent Auto-Continue.app"
echo "Verifying $app"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=2 "$app"
xcrun stapler validate "$app"
echo "Rehearsal passed. The artifacts in dist/ are signed and notarized."
