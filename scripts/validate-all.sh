#!/usr/bin/env bash
# Validates every region in its own Node process (in parallel). React test state can leak across
# regions inside one jsdom, so each region gets a fresh process.
set -u
JOBS="${VALIDATE_JOBS:-$(nproc 2>/dev/null || echo 4)}"
dir=$(mktemp -d)
regions=$(for d in src/content/*/; do t=$(basename "$d"); [ "$t" != datasets ] && echo "$t"; done)
printf '%s\n' $regions | xargs -P "$JOBS" -I{} sh -c 'node scripts/validate-content.ts "{}/" > "'"$dir"'/{}.log" 2>&1; echo $? > "'"$dir"'/{}.code"'
fail=0
for t in $regions; do
  code=$(cat "$dir/$t.code")
  echo "── $t: $(grep -E 'lessons ·' "$dir/$t.log") $(grep -E 'all good|error\(s\)' "$dir/$t.log")"
  if [ "$code" != 0 ]; then grep -E "✖" "$dir/$t.log" | head -30; fail=1; fi
done
rm -rf "$dir"
exit $fail
