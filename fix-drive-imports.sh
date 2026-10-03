#!/usr/bin/env bash
# Run from the repository root on local main, after resolve-tabs-conflict.sh.
#
# The stashed Drive screen came from an older redesign and imports modules that
# don't exist on current main (@/components/Icon, @/components/ui, `ui` from
# @/constants/colors). This restores the committed (current main) version of
# any working-tree file that fails to typecheck only because of such imports,
# keeps the native iOS tab bar from 2971741, runs the checks and commits.
# Nothing is deleted from the stash.
set -euo pipefail

MOBILE="artifacts/mobile"
LAYOUT="$MOBILE/app/(tabs)/_layout.tsx"
DRIVE="$MOBILE/app/(tabs)/(drive)/index.tsx"
SCAN=(git grep -lE '^(<{7}|>{7})( |$)|^={7}$' -- . ':!pnpm-lock.yaml')
OLD_IMPORTS='@/components/(Icon|ui|Cards|Scenery|Settings|GlassTabBar)["'"'"']|@/hooks/useAvatarPicker|react-native-screens/experimental|import \{[^}]*\b(ui|calm|radii|type)\b[^}]*\} from "@/constants/colors"'

# 0. The tab layout must be the native tab bar from 2971741.
if ! grep -q "NativeTabs" "$LAYOUT"; then
  git checkout 2971741 -- "$LAYOUT"
fi

# 1. The Drive screen: back to the committed version if it uses old modules.
if grep -qE "$OLD_IMPORTS" "$DRIVE"; then
  echo "Restoring the current Drive screen ($DRIVE): it imported modules main doesn't have."
  git checkout HEAD -- "$DRIVE"
fi

# 2. Any other changed file under artifacts/mobile with the same old imports.
for f in $(git diff --name-only HEAD -- "$MOBILE" | grep -E '\.(ts|tsx)$' || true); do
  if [ -f "$f" ] && grep -qE "$OLD_IMPORTS" "$f"; then
    if git cat-file -e "HEAD:$f" 2>/dev/null; then
      echo "Restoring $f: it imported modules main doesn't have."
      git checkout HEAD -- "$f"
    else
      echo "Removing $f: a new file from the old redesign that main doesn't have."
      git rm -q --cached -- "$f" 2>/dev/null || true; rm -f -- "$f"
    fi
  fi
done
# Untracked files from the old redesign (never on main).
for f in components/Icon.tsx components/ui.tsx components/Cards.tsx components/Scenery.tsx components/Settings.tsx components/GlassTabBar.tsx hooks/useAvatarPicker.ts; do
  p="$MOBILE/$f"
  if [ -f "$p" ] && ! git cat-file -e "HEAD:$p" 2>/dev/null; then
    echo "Removing $p: not part of current main."
    git rm -q --cached -- "$p" 2>/dev/null || true; rm -f -- "$p"
  fi
done
git add -A "$MOBILE"

# 3. Checks.
if [ -n "$(git diff --name-only --diff-filter=U)" ]; then echo "Unmerged paths remain"; exit 1; fi
if "${SCAN[@]}"; then echo "Conflict markers remain (listed above)."; exit 1; fi
echo "Conflict-marker scan: clean"
pnpm run typecheck
pnpm --filter @workspace/mobile run test
(cd "$MOBILE" && npx expo export --platform ios --clear --output-dir "${TMPDIR:-/tmp}/derwent-ios-export")

# 4. Commit (only reached if everything above passed).
if git diff --cached --quiet; then
  echo "Nothing left to commit: your tree matches the committed state."
else
  git commit -m "Keep the current Drive screen and the native iOS tab bar"
fi
git log --oneline -1
grep -q "NativeTabs" "$LAYOUT" && echo "Native iOS tab bar: present"
echo "Done. Your stash entry was kept; once you're happy: git stash drop"
