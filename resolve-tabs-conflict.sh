#!/usr/bin/env bash
# Resolves the `git stash pop` conflict in app/(tabs)/_layout.tsx after
# cherry-picking 2971741 onto local main. Run from the repository root.
#
# - _layout.tsx: keeps the native iOS tab bar exactly as in 2971741.
# - Every other file from the stash keeps your local changes, unless a file
#   still contains conflict markers; then it goes back to the committed version
#   (your edits stay in the stash, which this script never drops).
# - Runs the conflict scan, typecheck, unit tests and an iOS export, and commits
#   only if all of them pass.
set -euo pipefail

LAYOUT="artifacts/mobile/app/(tabs)/_layout.tsx"
SCAN=(git grep -lE '^(<{7}|>{7})( |$)|^={7}$' -- . ':!pnpm-lock.yaml')

git cat-file -e 2971741^{commit} || { echo "2971741 is not in this repository; run: git fetch origin"; exit 1; }
grep -q "NativeTabs" <(git show 2971741:"$LAYOUT") || { echo "2971741 has no NativeTabs layout"; exit 1; }

# 1. The conflicted tab layout: take the native tab bar version.
git checkout 2971741 -- "$LAYOUT"
git add "$LAYOUT"

# 2. Any other file still carrying conflict markers (e.g. an older local merge).
for f in $("${SCAN[@]}" || true); do
  echo "Conflict markers in $f: restoring the committed version (your edits remain in the stash)."
  git checkout HEAD -- "$f"
done
git add -A artifacts/mobile

# 3. Nothing may still be unmerged or contain markers.
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo "Unmerged paths remain:"; git diff --name-only --diff-filter=U; exit 1; fi
if "${SCAN[@]}"; then echo "Conflict markers remain (listed above)."; exit 1; fi
echo "Conflict-marker scan: clean"

# 4. Checks.
pnpm run typecheck
pnpm --filter @workspace/mobile run test
(cd artifacts/mobile && npx expo export --platform ios --clear --output-dir "${TMPDIR:-/tmp}/derwent-ios-export")

# 5. Commit the resolution (only reached if everything above passed).
git commit -m "Resolve stash conflict: keep the native iOS tab bar from 2971741"
git log --oneline -1
echo "Done. Your stash entry was kept; once you're happy: git stash drop"
