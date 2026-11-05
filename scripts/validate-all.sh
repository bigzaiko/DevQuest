#!/usr/bin/env bash
# Validates each region in its own Node process (React test state can leak across regions in one jsdom).
set -u
fail=0
for d in src/content/*/; do
  t=$(basename "$d"); [ "$t" = datasets ] && continue
  out=$(node scripts/validate-content.ts "$t/" 2>&1); code=$?
  echo "── $t: $(echo "$out" | tail -2 | tr '\n' ' ')"
  if [ $code -ne 0 ]; then echo "$out" | grep -E "✖" | head -20; fail=1; fi
done
exit $fail
