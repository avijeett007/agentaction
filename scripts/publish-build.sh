#!/usr/bin/env bash
#
# Publish an app build as a downloadable GitHub Release asset.
#
#   scripts/publish-build.sh v0.2.0 ~/Downloads/agentaction-0.2.0.apk [more files…]
#
# Until the app is on Google Play, the APK people install comes from a release
# here, and a file downloaded outside a store has nothing vouching for it but
# its checksum. So this script refuses to publish a file it cannot identify,
# always records the SHA-256, and puts that checksum in the release notes where
# the person downloading can actually see it.
#
# It is deliberately dumb about building: EAS does that, and a script that both
# builds and publishes is a script that publishes the wrong build one day.
set -euo pipefail

REPO="${AGENTACTION_REPO:-avijeett007/agentaction}"

die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: $(basename "$0") <tag> <file> [file…]
example: $(basename "$0") v0.2.0 ~/Downloads/agentaction-0.2.0.apk"

TAG="$1"; shift
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "tag should look like v0.2.0, got '$TAG'"

command -v gh >/dev/null || die "the GitHub CLI (gh) is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not logged in — run: gh auth login"

# ── Check every file before anything is published ───────────────────────────
NOTES_FILE="$(mktemp -t agentaction-release)"
trap 'rm -f "$NOTES_FILE"' EXIT

{
  printf '## AgentAction %s\n\n' "${TAG#v}"
  printf 'What is new\n- _fill this in before you announce it_\n\n'
} >>"$NOTES_FILE"

ANDROID_FILE=""
for FILE in "$@"; do
  [ -f "$FILE" ] || die "no such file: $FILE"

  case "$FILE" in
    *.apk)
      # An APK is a zip whose first entry is normally AndroidManifest.xml; the
      # point is only to catch "you uploaded the .aab" and similar slips.
      unzip -l "$FILE" 2>/dev/null | grep -q "AndroidManifest.xml" \
        || die "$FILE does not look like an APK (no AndroidManifest.xml inside)"
      ANDROID_FILE="$(basename "$FILE")"
      ;;
    *.aab)
      die "$FILE is an Android App Bundle — that is for Google Play, not for download.
Build the downloadable one with: npx eas-cli build --platform android --profile release-apk"
      ;;
    *.ipa)
      printf '\nnote: %s is an iOS build. It installs ONLY on phones whose UDID was\n' "$(basename "$FILE")"
      printf '      registered before it was built. For everyone else, use TestFlight —\n'
      printf '      see docs/releasing.md step 5.\n\n'
      ;;
    *) die "$FILE — expected an .apk or .ipa" ;;
  esac
done

# ── Checksums, in the notes and on screen ───────────────────────────────────
{
  printf 'Install on Android\n'
  if [ -n "$ANDROID_FILE" ]; then
    printf '1. Download `%s` below.\n' "$ANDROID_FILE"
    printf '2. Open it. Android asks whether to allow installs from your browser — say yes.\n'
    printf '3. Already have the app? This installs over it and keeps your pairings.\n\n'
  fi
  printf 'Checksums (SHA-256)\n\n```\n'
} >>"$NOTES_FILE"

for FILE in "$@"; do
  if command -v shasum >/dev/null; then SUM="$(shasum -a 256 "$FILE")"; else SUM="$(sha256sum "$FILE")"; fi
  printf '%s  %s\n' "${SUM%% *}" "$(basename "$FILE")" >>"$NOTES_FILE"
done
printf '```\n' >>"$NOTES_FILE"

printf '\n── release notes ──────────────────────────────────────────\n'
cat "$NOTES_FILE"
printf '───────────────────────────────────────────────────────────\n\n'

# ── Publish ─────────────────────────────────────────────────────────────────
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  printf 'Release %s already exists — uploading (and replacing) these files.\n' "$TAG"
  gh release upload "$TAG" "$@" --repo "$REPO" --clobber
else
  gh release create "$TAG" "$@" \
    --repo "$REPO" \
    --title "AgentAction ${TAG#v}" \
    --notes-file "$NOTES_FILE"
fi

printf '\nPublished: https://github.com/%s/releases/tag/%s\n' "$REPO" "$TAG"
printf 'Latest-release link to hand out: https://github.com/%s/releases/latest\n\n' "$REPO"
printf 'Now edit the notes to say what actually changed:\n  gh release edit %s --repo %s --notes-file <file>\n' "$TAG" "$REPO"
