#!/usr/bin/env bash
# Archive the iPhone app and upload it to TestFlight.
#
# One-time setup (needs a paid Apple Developer Program membership):
#   1. App Store Connect > Users and Access > Integrations > App Store Connect API > Team keys:
#      generate a key with the "App Manager" role, note its Key ID and Issuer ID, download AuthKey_<KEYID>.p8
#      into ~/.appstoreconnect/private_keys/ (that folder is where xcodebuild looks).
#   2. App Store Connect > Apps > "+" > New App: platform iOS, name "VPS Panel",
#      bundle ID in.co.helloworlds.vpspanel (register it first at developer.apple.com > Identifiers if missing).
#   3. Put the two IDs in ios/deploy/.env (ignored by git):
#        ASC_KEY_ID=ABC123DEFG
#        ASC_ISSUER_ID=12345678-1234-1234-1234-123456789012
#
# Then every release is:   ios/deploy/testflight.sh
# The build number is the git commit count, so every upload is newer than the last.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
[[ -f deploy/.env ]] && set -a && source deploy/.env && set +a
: "${ASC_KEY_ID:?set ASC_KEY_ID in ios/deploy/.env}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID in ios/deploy/.env}"
KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
[[ -f "$KEY_PATH" ]] || { echo "API key not found at $KEY_PATH" >&2; exit 1; }

BUILD="$(git -C "$DIR" rev-list --count HEAD)"
VERSION="${MARKETING_VERSION:-$(grep -E '^\s*MARKETING_VERSION:' project.yml | sed -E 's/.*"([^"]+)".*/\1/')}"
OUT="$DIR/build/testflight"
ARCHIVE="$OUT/VPSPanel.xcarchive"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

log "generating Xcode project"
xcodegen generate >/dev/null

log "archiving VPS Panel $VERSION ($BUILD)"
rm -rf "$OUT"
xcodebuild archive \
  -project VPSPanel.xcodeproj -scheme VPSPanel -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  CURRENT_PROJECT_VERSION="$BUILD" MARKETING_VERSION="$VERSION" \
  "${AUTH[@]}" | grep -E 'error:|warning: .*signing|ARCHIVE (SUCCEEDED|FAILED)' || true
[[ -d "$ARCHIVE" ]] || { echo "archive failed" >&2; exit 1; }

log "uploading to App Store Connect"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" -exportOptionsPlist deploy/ExportOptions.plist -exportPath "$OUT/export" \
  "${AUTH[@]}" | grep -E 'error:|EXPORT (SUCCEEDED|FAILED)|Upload' || true

log "done: $VERSION ($BUILD) uploaded. It appears in TestFlight after Apple processes it (5-15 min)."
