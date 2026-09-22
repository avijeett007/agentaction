#!/usr/bin/env bash
# Publish this repository's current state to the public repository.
#
#   scripts/publish-public.sh            # build and audit a candidate, show the diff
#   scripts/publish-public.sh --push     # ...and push it as the public main
#
# The public repository gets a SNAPSHOT, one commit per publish on top of its
# own history. Local history, branches and commit messages never leave. Paths
# listed in .publish/exclude are removed, and the result must pass three
# checks before it can be pushed:
#   1. generic secret patterns (below),
#   2. .publish/denylist — our own hosts, accounts and ids (private),
#   3. ggshield, when it is installed.
#
# The `public` remote's push URL is deliberately disabled, so a plain
# `git push public` cannot publish private history by mistake. This script
# pushes to the fetch URL explicitly.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
REMOTE=public
BRANCH=main
PUSH=false
[[ "${1:-}" == "--push" ]] && PUSH=true

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "publish: commit or discard tracked changes first" >&2
  exit 1
fi

URL=$(git remote get-url "$REMOTE")
git fetch --quiet "$REMOTE" "$BRANCH"
PARENT=$(git rev-parse "$REMOTE/$BRANCH")

# 1. The tree: HEAD minus everything in .publish/exclude.
INDEX=$(mktemp)
trap 'rm -f "$INDEX"; rm -rf "${SCAN_DIR:-}"' EXIT
GIT_INDEX_FILE=$INDEX git read-tree HEAD
while IFS= read -r path; do
  [[ -z "$path" || "$path" == \#* ]] && continue
  GIT_INDEX_FILE=$INDEX git rm -r --cached --quiet --ignore-unmatch -- "$path"
done < .publish/exclude
TREE=$(GIT_INDEX_FILE=$INDEX git write-tree)

# 2. The audit.
FAIL=0
GENERIC='-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"[[:space:]]*:|aa_live_[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9]{16,}|sk_live_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|EXPO_ACCESS_TOKEN=[^[:space:]…]+'
if git grep -I -n -E "$GENERIC" "$TREE" -- . ':!**/package-lock.json' >/tmp/publish-generic.$$ 2>/dev/null; then
  echo "publish: secret-shaped strings found:" >&2
  sed "s/^$TREE://" /tmp/publish-generic.$$ >&2
  FAIL=1
fi
rm -f /tmp/publish-generic.$$

if [[ -f .publish/denylist ]]; then
  while IFS= read -r pattern; do
    [[ -z "$pattern" || "$pattern" == \#* ]] && continue
    if git grep -I -n -i -E "$pattern" "$TREE" -- . ':!**/package-lock.json' >/tmp/publish-deny.$$ 2>/dev/null; then
      echo "publish: private term /$pattern/ found:" >&2
      sed "s/^$TREE://" /tmp/publish-deny.$$ >&2
      FAIL=1
    fi
  done < .publish/denylist
  rm -f /tmp/publish-deny.$$
fi

# git grep skips binary files, so a source file git thinks is binary (a stray
# NUL byte is enough) would never be scanned. Refuse it instead.
while IFS= read -r path; do
  case "$path" in
    *.js|*.mjs|*.cjs|*.ts|*.tsx|*.json|*.md|*.html|*.css|*.txt|*.yml|*.yaml|*.sh|*.prisma|*.svg|*.xml|*.toml)
      if [[ "$(git diff --numstat 4b825dc642cb6eb9a060e54bf8d69288fbee4904 "$TREE" -- "$path" | cut -f1)" == "-" ]]; then
        echo "publish: $path is text but git sees it as binary, so it cannot be scanned" >&2
        FAIL=1
      fi
      ;;
  esac
done < <(git ls-tree -r --name-only "$TREE")

for forbidden in .env eas.local.json google-services.json GoogleService-Info.plist; do
  if git ls-tree -r --name-only "$TREE" | grep -E "(^|/)${forbidden//./\\.}$" | grep -v '\.example$'; then
    echo "publish: forbidden file $forbidden is in the tree" >&2
    FAIL=1
  fi
done
if git ls-tree -r --name-only "$TREE" | grep -E '\.db(-journal)?$'; then
  echo "publish: a database file is in the tree" >&2
  FAIL=1
fi

if command -v ggshield >/dev/null 2>&1; then
  SCAN_DIR=$(mktemp -d)
  git archive "$TREE" | tar -x -C "$SCAN_DIR"
  if ! ggshield secret scan path -r -y "$SCAN_DIR" >/dev/null 2>&1; then
    echo "publish: ggshield reported a secret — run: ggshield secret scan path -r <checkout>" >&2
    FAIL=1
  fi
else
  echo "publish: ggshield not installed — skipped its scan" >&2
fi

if [[ $FAIL -ne 0 ]]; then
  echo "publish: NOT published. Fix the findings above." >&2
  exit 1
fi

# 3. The candidate: one commit on top of the public history.
if [[ "$(git rev-parse "$PARENT^{tree}")" == "$TREE" ]]; then
  echo "publish: the public repository is already up to date."
  exit 0
fi
MESSAGE="${PUBLISH_MESSAGE:-Update from $(git rev-parse --short HEAD)}"
COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MESSAGE")
git update-ref refs/publish/candidate "$COMMIT"

echo "publish: audit clean. Candidate $COMMIT on top of $REMOTE/$BRANCH:"
git diff --stat "$PARENT" "$COMMIT"

if $PUSH; then
  git push "$URL" "$COMMIT:refs/heads/$BRANCH"
  git fetch --quiet "$REMOTE" "$BRANCH"
  echo "publish: pushed."
else
  echo "publish: dry run. Review with: git diff $PARENT refs/publish/candidate"
  echo "publish: then run again with --push."
fi
